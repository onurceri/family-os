import { describe, expect, it, vi } from 'vitest';
import { importAll, packageFiles, parseExtensionList, sourceEntries } from './extension-loading.js';

const garden = {
	id: 'garden',
	version: '0.1.0',
	entry: '/extensions/garden/abc/web/index.js',
	css: '/extensions/garden/abc/web/styles.css',
	files: ['/extensions/garden/abc/web/index.js', '/extensions/garden/abc/web/styles.css'],
};

describe('the list in the shell', () => {
	it('reads what the server wrote', () => {
		const text = JSON.stringify({ fingerprint: 'f1', extensions: [garden] });
		expect(parseExtensionList(text)).toEqual({ fingerprint: 'f1', extensions: [garden] });
		expect(packageFiles(parseExtensionList(text))).toEqual(garden.files);
	});

	it.each([
		['no list', null],
		['an empty one', ''],
		['broken JSON', '{"fingerprint":'],
		['another shape', '[1,2]'],
	])('gives no extensions for %s', (_what, text) => {
		expect(parseExtensionList(text)).toEqual({ fingerprint: '', extensions: [] });
	});

	it('leaves out an entry it cannot read', () => {
		const text = JSON.stringify({
			fingerprint: 'f1',
			extensions: [garden, { id: 'orchard', entry: 7 }, { ...garden, id: 'pond', files: [1] }],
		});
		expect(parseExtensionList(text).extensions.map((e) => e.id)).toEqual(['garden']);
	});
});

describe('importing the extensions', () => {
	it('keeps the ones that load, in order, and reports the others', async () => {
		const onError = vi.fn();
		const broken = new Error('404');
		const loaded = await importAll(
			[
				{ id: 'a', load: async () => ({ default: 'A' }) },
				{ id: 'b', load: () => Promise.reject(broken) },
				{ id: 'c', load: async () => ({ default: 'C' }) },
			],
			onError,
		);
		expect(loaded).toEqual(['A', 'C']);
		expect(onError).toHaveBeenCalledExactlyOnceWith('b', broken);
	});

	it('starts every import at once', async () => {
		const started: string[] = [];
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slow = (id: string) => ({
			id,
			load: async () => {
				started.push(id);
				await gate;
				return { default: id };
			},
		});
		const all = importAll([slow('a'), slow('b')], () => {});
		expect(started).toEqual(['a', 'b']);
		release();
		expect(await all).toEqual(['a', 'b']);
	});
});

describe('extensions from source (the dev server)', () => {
	const load = async () => ({ default: 'x' });
	const modules = {
		'../../../../extensions/pond/src/web/index.ts': load,
		'../../../../extensions/garden/src/web/index.ts': load,
		'../../../../extensions/orchard/src/web/index.ts': load,
	};

	it('takes only what the server runs, by id', () => {
		expect(sourceEntries(modules, ['pond', 'garden']).map((e) => e.id)).toEqual(['garden', 'pond']);
	});

	it('takes none when the server runs none', () => {
		expect(sourceEntries(modules, [])).toEqual([]);
	});
});
