// Gathers the built extension packages (extensions/<id>/dist, written by `famos-pack`) and
// extensions.json into dist/extensions/, the folder the image ships. Run by `pnpm build` after
// turbo has built every package. extensions.json says which packages are always there and which
// are offered; a package it does not name, or one it names that was not built, fails the build.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const out = join(root, 'dist', 'extensions');
const listed = JSON.parse(readFileSync(join(root, 'extensions.json'), 'utf8'));
const ids = [...listed.always, ...listed.offered];

const problems = [];
const folders = readdirSync(join(root, 'extensions'), { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.filter((name) => existsSync(join(root, 'extensions', name, 'package.json')));
for (const name of folders) {
	if (!ids.includes(name)) problems.push(`extensions/${name} is not in extensions.json`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const id of ids) {
	const from = join(root, 'extensions', id, 'dist');
	const description = join(from, 'famos-package.json');
	if (!existsSync(description)) {
		problems.push(`extensions/${id} has no built package (${description})`);
		continue;
	}
	const { manifest } = JSON.parse(readFileSync(description, 'utf8'));
	if (manifest.id !== id) {
		problems.push(`extensions/${id}/dist holds the package of "${manifest.id}"`);
		continue;
	}
	cpSync(from, join(out, id), { recursive: true });
}
cpSync(join(root, 'extensions.json'), join(out, 'extensions.json'));

if (problems.length > 0) {
	console.error(problems.join('\n'));
	process.exit(1);
}
console.log(`✔ ${ids.length} extension packages in dist/extensions`);
