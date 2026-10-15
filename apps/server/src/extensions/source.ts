import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** An extension's workspace source: its folder, its server entry and its raw manifest. */
export interface SourceExtension {
	dir: string;
	entry: string;
	manifest: unknown;
}

/**
 * The extensions under a workspace folder (`extensions/`): every subfolder whose package.json has
 * a `famos` manifest and a `./server` export. Only for development and tests: this code is
 * unbuilt and unsigned, and imports whatever its own dependencies hold.
 */
export function discoverSourceExtensions(root: string): SourceExtension[] {
	const dir = resolve(root);
	if (!existsSync(dir)) throw new Error(`FAMOS_DEV_EXTENSIONS: ${dir} does not exist`);
	const found: SourceExtension[] = [];
	for (const name of readdirSync(dir).sort()) {
		const file = join(dir, name, 'package.json');
		if (!existsSync(file)) continue;
		const pkg = JSON.parse(readFileSync(file, 'utf8')) as {
			famos?: unknown;
			exports?: Record<string, unknown>;
		};
		const server = pkg.exports?.['./server'];
		if (pkg.famos === undefined || typeof server !== 'string') continue;
		found.push({ dir: join(dir, name), entry: join(dir, name, server), manifest: pkg.famos });
	}
	if (found.length === 0) throw new Error(`FAMOS_DEV_EXTENSIONS: no extensions in ${dir}`);
	return found;
}
