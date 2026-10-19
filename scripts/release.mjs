// Prepares a release locally: sets the version, commits and tags. Pushing is left to a person.
//   node scripts/release.mjs <x.y.z>   (pnpm release <x.y.z>)
// The extensions the image ships (extensions.json `always` and `offered`) are released with the
// product and take its version too; one released on its own (`independent`) keeps its own. A
// pre-release (1.0.0-rc.1) leaves the extensions alone: a package version has no pre-release
// part, and its packages are not published.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/** The product version lives in these manifests (the server reports it, the web shows it). */
const MANIFESTS = ['apps/server/package.json', 'apps/web/package.json'];
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const version = process.argv[2];
if (!version || !SEMVER.test(version)) {
	console.error('Usage: pnpm release <x.y.z> (SemVer, e.g. 0.2.0 or 1.0.0-rc.1)');
	process.exit(2);
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git('status', '--porcelain')) {
	console.error('The working tree has changes; commit or stash them first.');
	process.exit(1);
}
if (git('tag', '--list', `v${version}`)) {
	console.error(`Tag v${version} already exists.`);
	process.exit(1);
}

/**
 * The new text of every file the release changes, all worked out before any is written. An
 * extension's version is in its package.json twice, the package's own and its manifest's
 * (`famos.version`), which must agree; both lines are replaced in place, so the file keeps its
 * formatting, and the result is read back to prove it.
 */
const changes = MANIFESTS.map((file) => [
	file,
	readFileSync(file, 'utf8').replace(/"version": "[^"]+"/, `"version": "${version}"`),
]);
if (existsSync('extensions.json') && !version.includes('-')) {
	const listed = JSON.parse(readFileSync('extensions.json', 'utf8'));
	for (const id of [...listed.always, ...listed.offered]) {
		const file = `extensions/${id}/package.json`;
		const text = readFileSync(file, 'utf8')
			.replace(/^(\t"version": )"[^"]+"/m, `$1"${version}"`)
			.replace(/^(\t"famos": \{\n(?:\t\t.*\n)*?\t\t"version": )"[^"]+"/m, `$1"${version}"`);
		const pkg = JSON.parse(text);
		if (pkg.version !== version || pkg.famos?.version !== version) {
			console.error(`Could not set the version in ${file}; check its formatting.`);
			process.exit(1);
		}
		changes.push([file, text]);
	}
}
for (const [file, text] of changes) writeFileSync(file, text);
git('add', ...changes.map(([file]) => file));
// The first release may already carry its version: then the tag goes on the commit as it is.
if (git('diff', '--cached', '--name-only')) git('commit', '-m', `chore(release): ${version}`);
git('tag', '-a', `v${version}`, '-m', `FamilyOS ${version}`);
console.log(`Tagged v${version}. Check the notes, then push:\n`);
console.log(execFileSync('node', ['scripts/release-notes.mjs', version], { encoding: 'utf8' }));
console.log('  git push origin main --follow-tags');
