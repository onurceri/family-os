// Writes the runtime image's package.json and package-lock.json from pnpm-lock.yaml, so the
// native modules installed beside the server bundle are exactly the locked versions (with their
// integrity hashes) and nothing floats at image build time. Usage:
//   node scripts/runtime-lock.mjs <out-dir>
// The modules are installed per architecture in the runtime stage with `npm ci`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Native modules the server bundle leaves external, with the dependency each is listed under. */
export const EXTERNAL_MODULES = ['better-sqlite3'];

function section(text, name) {
	const start = text.lastIndexOf(`\n${name}:\n`);
	if (start === -1) throw new Error(`pnpm-lock.yaml has no ${name} section`);
	const rest = text.slice(start + name.length + 3);
	const end = rest.search(/\n\S/);
	return end === -1 ? rest : rest.slice(0, end);
}

/** Entries of a section: key (without quotes and peer suffix) to its indented lines. */
function entries(body) {
	const map = new Map();
	let key = null;
	for (const line of body.split('\n')) {
		const head = /^ {2}(\S.*?):(?: \{.*\})?$/.exec(line);
		if (head) {
			key = head[1].replace(/^'|'$/g, '').replace(/\(.*$/, '');
			map.set(key, []);
		} else if (key && line.trim()) map.get(key).push(line);
	}
	return map;
}

/**
 * The locked closure of `roots` (package name to version): every package with its version,
 * integrity hash and dependencies, as an npm lockfile (version 3).
 */
export function runtimeLock(lockText, roots) {
	const packages = entries(section(lockText, 'packages'));
	const snapshots = entries(section(lockText, 'snapshots'));
	const found = new Map();
	const walk = (name, version) => {
		const key = `${name}@${version}`;
		const seen = found.get(name);
		if (seen) {
			if (seen.version !== version) {
				throw new Error(
					`${name} is locked at ${seen.version} and ${version}; the flat runtime install cannot hold both`,
				);
			}
			return;
		}
		const pkg = packages.get(key);
		const integrity = pkg?.join('\n').match(/integrity: ([^,}\s]+)/)?.[1];
		if (!integrity) throw new Error(`${key} is not in pnpm-lock.yaml`);
		const dependencies = {};
		let optional = false;
		for (const line of snapshots.get(key) ?? []) {
			const dep = /^ {6}(\S+?): (\S+)$/.exec(line);
			if (dep) dependencies[dep[1].replace(/^'|'$/g, '')] = dep[2].replace(/\(.*$/, '');
			else if (/^ {4}optional: true/.test(line)) optional = true;
		}
		found.set(name, { version, integrity, dependencies, optional });
		for (const [dep, depVersion] of Object.entries(dependencies)) walk(dep, depVersion);
	};
	for (const [name, version] of Object.entries(roots)) walk(name, version);

	const lock = {
		name: 'famos-runtime',
		lockfileVersion: 3,
		requires: true,
		packages: { '': { name: 'famos-runtime', dependencies: roots } },
	};
	for (const [name, { version, integrity, dependencies }] of [...found].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		const encoded = name.split('/').pop();
		lock.packages[`node_modules/${name}`] = {
			version,
			resolved: `https://registry.npmjs.org/${name}/-/${encoded}-${version}.tgz`,
			integrity,
			...(Object.keys(dependencies).length > 0 && { dependencies }),
		};
	}
	return lock;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const out = process.argv[2];
	if (!out) throw new Error('usage: node scripts/runtime-lock.mjs <out-dir>');
	const server = JSON.parse(readFileSync('apps/server/package.json', 'utf8'));
	const roots = Object.fromEntries(
		EXTERNAL_MODULES.map((name) => [name, server.dependencies[name]]),
	);
	const lock = runtimeLock(readFileSync('pnpm-lock.yaml', 'utf8'), roots);
	mkdirSync(out, { recursive: true });
	writeFileSync(
		join(out, 'package.json'),
		JSON.stringify({ name: 'famos-runtime', private: true, type: 'module', dependencies: roots }),
	);
	writeFileSync(join(out, 'package-lock.json'), JSON.stringify(lock));
}
