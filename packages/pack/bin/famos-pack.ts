#!/usr/bin/env node
// Builds the extension in the current folder into its package folder, dist/. Run by Node
// directly (type stripping); no build step of its own.
import { relative } from 'node:path';
import { buildExtension } from '../src/package.ts';

try {
	const { outDir, description } = await buildExtension(process.cwd());
	const files = Object.keys(description.files).length + 1;
	console.log(
		`${description.manifest.id}@${description.manifest.version} → ${relative(process.cwd(), outDir)}/ (${files} files)`,
	);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
