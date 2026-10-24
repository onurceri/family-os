import { describe, expect, it } from 'vitest';
import { LoadSequence, loadKeeping } from './latest.js';

describe('LoadSequence', () => {
	it('only the newest load is current', () => {
		const loads = new LoadSequence();
		const slow = loads.begin();
		const fast = loads.begin();
		expect(loads.isCurrent(slow)).toBe(false);
		expect(loads.isCurrent(fast)).toBe(true);
	});

	it('an older response arriving last does not overwrite a newer one', async () => {
		const loads = new LoadSequence();
		let shown = '';
		const resolvers: Record<string, (v: string) => void> = {};
		const run = async (name: string) => {
			const load = loads.begin();
			const value = await new Promise<string>((resolve) => (resolvers[name] = resolve));
			if (loads.isCurrent(load)) shown = value;
		};
		const first = run('first');
		const second = run('second');
		resolvers.second?.('new');
		resolvers.first?.('old');
		await Promise.all([first, second]);
		expect(shown).toBe('new');
	});
});

describe('loadKeeping', () => {
	it('keeps the last good answer when the source fails', async () => {
		const kept = new Map<string, string[]>();
		expect(await loadKeeping(kept, 'a', async () => ['x'], [])).toEqual(['x']);
		expect(
			await loadKeeping(
				kept,
				'a',
				async () => {
					throw new Error('down');
				},
				[],
			),
		).toEqual(['x']);
	});

	it('answers empty for a source that never worked', async () => {
		const result = await loadKeeping(
			new Map<string, string[]>(),
			'a',
			async () => {
				throw new Error('down');
			},
			[],
		);
		expect(result).toEqual([]);
	});
});
