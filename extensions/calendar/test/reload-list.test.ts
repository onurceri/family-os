import { describe, expect, it } from 'vitest';
import { readList } from '../src/web/reload-list.js';

describe('readList', () => {
	it('returns the list read and says the read worked, empty included', async () => {
		expect(await readList(async () => [], ['old'])).toEqual({ list: [], ok: true });
		expect(await readList(async () => ['new'], ['old'])).toEqual({ list: ['new'], ok: true });
	});

	it('keeps the list on screen when the read fails', async () => {
		const failing = async (): Promise<string[]> => {
			throw new Error('down');
		};
		expect(await readList(failing, ['old'])).toEqual({ list: ['old'], ok: false });
	});

	it('shows nothing, and not "empty", when the first read fails', async () => {
		const failing = async (): Promise<string[]> => {
			throw new Error('down');
		};
		expect((await readList(failing, [])).ok).toBe(false);
	});
});
