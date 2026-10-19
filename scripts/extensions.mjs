// Packs, signs and publishes extension packages (the release workflows run it):
//   node scripts/extensions.mjs pack [<id>…] --out <dir> (--key-env <VAR> | --key-file <pem>)
//       [--version <x.y.z>]
//     Packs each built package (extensions/<id>/dist, from `pnpm build`) into
//     <dir>/<id>-<version>.famext, signed. Without ids: every extension extensions.json ships.
//     With --version, a package of another version is refused (a release publishes one).
//   node scripts/extensions.mjs index <dir> [--add <file.famext>…] [--keep <n>]
//     Copies the files into the published folder (<dir>/<id>/), keeps the newest n versions of
//     each (5) and writes <dir>/index.json.
//   node scripts/extensions.mjs sign <file> (--key-env <VAR> | --key-file <pem>)
//     Writes <file>.sig, the signature of its exact bytes (how index.json is signed).
// The key is read from a file or an environment variable and never printed.
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import {
	ARCHIVE_EXTENSION,
	loadSigningKey,
	pack,
	signFile,
	writeIndex,
} from '../packages/pack/src/famext.ts';

const root = join(import.meta.dirname, '..');
const usage = `Usage:
  node scripts/extensions.mjs pack [<id>…] --out <dir> (--key-env <VAR> | --key-file <pem>) [--version <x.y.z>]
  node scripts/extensions.mjs index <dir> [--add <file.famext>…] [--keep <n>]
  node scripts/extensions.mjs sign <file> (--key-env <VAR> | --key-file <pem>)`;

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		out: { type: 'string' },
		version: { type: 'string' },
		'key-env': { type: 'string' },
		'key-file': { type: 'string' },
		add: { type: 'string', multiple: true },
		keep: { type: 'string' },
	},
});
const [command, ...rest] = positionals;

function fail(message) {
	console.error(message);
	process.exit(2);
}

function keySource() {
	const env = values['key-env'];
	const file = values['key-file'];
	if (Boolean(env) === Boolean(file)) fail(`Give the key with --key-env or --key-file.\n${usage}`);
	return env ? { env } : { file };
}

/** The extensions the image ships, which are released with the product. */
function lockstepIds() {
	const listed = JSON.parse(readFileSync(join(root, 'extensions.json'), 'utf8'));
	return [...listed.always, ...listed.offered];
}

try {
	switch (command) {
		case 'pack': {
			if (!values.out) fail(usage);
			const key = await loadSigningKey(keySource());
			const ids = rest.length > 0 ? rest : lockstepIds();
			await mkdir(values.out, { recursive: true });
			for (const id of ids) {
				const dir = join(root, 'extensions', id, 'dist');
				const description = JSON.parse(readFileSync(join(dir, 'famos-package.json'), 'utf8'));
				if (description.manifest?.id !== id) fail(`${dir} holds the package of another extension`);
				if (values.version && description.manifest.version !== values.version)
					fail(`${id} is version ${description.manifest.version}, not ${values.version}`);
				const out = join(values.out, `${id}-${description.manifest.version}${ARCHIVE_EXTENSION}`);
				const { signature } = await pack(dir, { privateKey: key, out });
				console.log(`${relative(process.cwd(), out)} (signed by ${signature.keyId})`);
			}
			break;
		}
		case 'index': {
			// `--add a.famext b.famext` (what a shell makes of `--add famext/*.famext`) gives the
			// option only its first file; the others arrive after the folder and count as well.
			const [dir, ...more] = rest;
			if (!dir) fail(usage);
			const keep = values.keep === undefined ? undefined : Number(values.keep);
			const { index, removed } = await writeIndex(dir, {
				add: [...(values.add ?? []), ...more],
				...(keep !== undefined && { keep }),
			});
			for (const path of removed) console.log(`removed ${path}`);
			console.log(`${join(dir, 'index.json')}: ${index.extensions.length} packages`);
			break;
		}
		case 'sign': {
			const [file] = rest;
			if (!file) fail(usage);
			const signature = await signFile(file, await loadSigningKey(keySource()));
			console.log(`${file}.sig (signed by ${signature.keyId})`);
			break;
		}
		default:
			fail(usage);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
