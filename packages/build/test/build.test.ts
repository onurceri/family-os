import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { SDK_VERSION } from '@famos/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import {
	buildExtension,
	PACKAGE_FILE,
	type PackageDescription,
	SHARED_SERVER,
} from '../src/index.ts';

const repo = join(import.meta.dirname, '..', '..', '..');
const extensions = readdirSync(join(repo, 'extensions')).filter((name) =>
	statSync(join(repo, 'extensions', name)).isDirectory(),
);
const scratch = mkdtempSync(join(tmpdir(), 'famos-build-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function filesUnder(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
		.sort();
}

describe.each(extensions)('the package of %s', (name) => {
	const dir = join(repo, 'extensions', name);
	const outDir = join(scratch, name);
	let building: ReturnType<typeof buildExtension> | undefined;
	const build = () => {
		building ??= buildExtension(dir, { outDir });
		return building;
	};

	it('builds, and its server bundle imports only what the host shares', async () => {
		const { serverImports } = await build();
		const unshared = serverImports.filter(
			(path) => !SHARED_SERVER.includes(path) && !path.startsWith('node:'),
		);
		expect(unshared).toEqual([]);
		expect(serverImports).toContain('@famos/sdk');
	});

	it('carries the manifest of its package.json, unchanged', async () => {
		await build();
		const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
		const description = JSON.parse(
			readFileSync(join(outDir, PACKAGE_FILE), 'utf8'),
		) as PackageDescription;
		expect(description.manifest).toEqual(pkg.famos);
		expect(description.name).toBe(pkg.name);
		expect(description.license).toBe(pkg.license);
		expect(description.built.sdk).toBe(SDK_VERSION);
		expect(description.entries.server).toBe('server/index.mjs');
		const en = JSON.parse(readFileSync(join(dir, 'src/messages/en.json'), 'utf8'));
		expect(description.labels.en).toEqual({
			name: en.feature_name,
			description: en.feature_description,
		});
	});

	it('lists every other file with its hash, and nothing else', async () => {
		await build();
		const description = JSON.parse(
			readFileSync(join(outDir, PACKAGE_FILE), 'utf8'),
		) as PackageDescription;
		const files = filesUnder(outDir).filter((path) => path !== PACKAGE_FILE);
		expect(Object.keys(description.files).sort()).toEqual(files);
		for (const path of files) {
			const hash = createHash('sha256')
				.update(readFileSync(join(outDir, path)))
				.digest('hex');
			expect(description.files[path], path).toBe(hash);
		}
		for (const code of readdirSync(join(dir, 'src/messages'))) {
			expect(files).toContain(`messages/${code}`);
		}
		expect(files).toEqual(expect.arrayContaining(['openapi.json', 'LICENSE', 'server/index.mjs']));
	});
});

describe('the server bundle', () => {
	async function fixture(name: string, source: string): Promise<string> {
		const dir = join(scratch, 'fixtures', name);
		await mkdir(join(dir, 'src/server'), { recursive: true });
		await mkdir(join(dir, 'src/messages'), { recursive: true });
		writeFileSync(
			join(dir, 'package.json'),
			JSON.stringify({
				name: `@example/${name}`,
				version: '0.1.0',
				license: 'MIT',
				famos: { id: name, version: '0.1.0', sdk: `^${SDK_VERSION}` },
			}),
		);
		writeFileSync(
			join(dir, 'src/messages/en.json'),
			JSON.stringify({ feature_name: 'Example', feature_description: 'An example.' }),
		);
		writeFileSync(join(dir, 'openapi.json'), '{}');
		writeFileSync(join(dir, 'LICENSE'), 'MIT');
		writeFileSync(join(dir, 'src/server/index.ts'), source);
		return dir;
	}

	it('refuses a builtin named without node:, which the host does not hand out', async () => {
		const dir = await fixture(
			'bare',
			"import { readFileSync } from 'fs';\nexport default readFileSync;\n",
		);
		await expect(buildExtension(dir)).rejects.toThrow(/imports fs, which the host does not share/);
	});

	it('refuses a subpath of a shared module, which is another module', async () => {
		const dir = await fixture('subpath', "import { z } from 'zod/mini';\nexport default z;\n");
		await expect(buildExtension(dir)).rejects.toThrow(/imports zod\/mini/);
	});

	it('inlines what the host does not share and keeps the shared modules out', async () => {
		const dir = await fixture(
			'inlined',
			"import { z } from 'zod';\nimport { createHash } from 'node:crypto';\nexport default [z, createHash];\n",
		);
		const { serverImports, description } = await buildExtension(dir);
		expect(serverImports).toEqual(['node:crypto', 'zod']);
		expect(description.labels).toEqual({ en: { name: 'Example', description: 'An example.' } });
		expect(description.license).toBe('MIT');
	});
});
