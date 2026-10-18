import type { Actor, DigestOutput, MemberId } from '@famos/sdk';
import type { TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { at, createKernel, type Person, person } from './support.ts';

// The clock stands at Tuesday 6 October 2026, 10:00.
let k: TestKernel;
let mara: Person;
let leo: Person;

beforeEach(async () => {
	({ k } = await createKernel());
	mara = await person(k, 'admin', 'Mara');
	leo = await person(k, 'member', 'Leo');
});
afterEach(() => k.close());

const ai: () => Actor = () => ({
	kind: 'ai',
	mode: 'conversation',
	source: 'assistant',
	onBehalfOf: mara.id as MemberId,
	roleId: 'admin',
});
const post = (input: Record<string, unknown>, actor = mara.actor) =>
	k.runner.invoke('board.postNote', input, actor);
const digest = async (input: Record<string, unknown>) => {
	const result = await k.runner.invoke<DigestOutput>('board.digest', input, ai());
	if (result.status !== 'applied') throw new Error('expected a read');
	return result.output;
};

describe('board.digest', () => {
	it('holds the notes up on some day of the span, pinned first, with who wrote them', async () => {
		await post({ text: 'Plumber comes Thursday', endsOn: '2026-10-08' });
		await post({ text: 'Wifi password is on the fridge', pinned: true });
		await post({ text: 'Gone by Wednesday', endsOn: '2026-10-07' });
		const out = await digest({ from: '2026-10-08', to: '2026-10-11' });
		expect(out.items.map((i) => i.title)).toEqual([
			'Wifi password is on the fridge',
			'Plumber comes Thursday',
		]);
		expect(out.items[0]).toMatchObject({ kind: 'note', status: 'pinned', people: [] });
		expect(out.items[1]).toMatchObject({
			date: '2026-10-08',
			end: { date: '2026-10-08' },
			extra: { posted: '2026-10-06', author: mara.id },
		});
	});

	it('leaves out a note posted after the span, and never one for the people asked about', async () => {
		await post({ text: 'Bake sale Friday' }, leo.actor);
		k.clock.set(at('2026-10-09', '10:00'));
		await post({ text: 'Posted later' });
		const out = await digest({ from: '2026-10-06', to: '2026-10-07', memberIds: [mara.id] });
		expect(out.items.map((i) => i.title)).toEqual(['Bake sale Friday']);
		expect(out.nextAfter).toBeUndefined();
	});

	it('ranks by the words asked about and keeps every note', async () => {
		await post({ text: 'Bake sale Friday' });
		await post({ text: 'Plumber comes Thursday' });
		const out = await digest({ from: '2026-10-06', to: '2026-10-06', about: ['plumber'] });
		expect(out.items.map((i) => i.title)).toEqual(['Plumber comes Thursday', 'Bake sale Friday']);
	});

	it('gives nothing to an AI whose area is off', async () => {
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'board', access: 'off' },
			mara.actor,
		);
		await expect(
			k.runner.invoke('board.digest', { from: '2026-10-06', to: '2026-10-06' }, ai()),
		).rejects.toMatchObject({ code: 'forbidden' });
	});
});
