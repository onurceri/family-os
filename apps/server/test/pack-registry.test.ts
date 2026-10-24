import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPackRegistry, MAX_INSTALLED_PACKS, type PackEntry } from '../src/pack-registry.ts';

interface Entry extends PackEntry {
	text: string;
}

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'famos-packs-'));
	await mkdir(join(root, 'bundled', 'one'), { recursive: true });
	await writeFile(join(root, 'bundled', 'one', 'pack.txt'), 'bundled one');
	await mkdir(join(root, 'bundled', 'broken'), { recursive: true });
	await mkdir(join(root, 'installed'), { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

function registry() {
	return createPackRegistry<Entry>({
		noun: 'test',
		idKey: 'id',
		logger: silentLogger,
		bundledDir: join(root, 'bundled'),
		installedDir: join(root, 'installed'),
		listFolders: (dir) => {
			try {
				return readdirSync(dir);
			} catch {
				return [];
			}
		},
		read: (dir, folder) => ({
			id: folder,
			entry: { text: readFileSync(join(dir, folder, 'pack.txt'), 'utf8') },
		}),
	});
}

const write = (text: string) => async (folder: string) => {
	await mkdir(folder, { recursive: true });
	await writeFile(join(folder, 'pack.txt'), text);
};

describe('the pack registry', () => {
	it('loads bundled packs, skips an unreadable one and counts reloads', async () => {
		const packs = registry();
		expect([...packs.entries.keys()]).toEqual(['one']);
		expect(packs.entries.get('one')).toMatchObject({ source: 'bundled', overridesBundled: false });
		expect(packs.version).toBe(1);
	});

	it('lets an installed pack replace a bundled one and reverts when removed', async () => {
		const packs = registry();
		const entry = await packs.install('one', write('mine'));
		expect(entry).toMatchObject({ source: 'installed', overridesBundled: true, text: 'mine' });
		await packs.remove('one');
		expect(packs.entries.get('one')).toMatchObject({ source: 'bundled', text: 'bundled one' });
		await expect(packs.remove('one')).rejects.toMatchObject({ code: 'not_found' });
	});

	it('refuses a new pack past the limit but still updates an installed one', async () => {
		const packs = registry();
		for (let i = 0; i < MAX_INSTALLED_PACKS; i++) await packs.install(`p${i}`, write('x'));
		await expect(packs.install('extra', write('x'))).rejects.toMatchObject({ code: 'conflict' });
		await expect(packs.install('p0', write('y'))).resolves.toMatchObject({ text: 'y' });
	});

	it('says so when an installed pack cannot be loaded', async () => {
		const packs = registry();
		await expect(packs.install('empty', (folder) => mkdir(folder))).rejects.toMatchObject({
			code: 'unavailable',
		});
	});
});
