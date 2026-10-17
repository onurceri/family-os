import { resolveMentions, SHARE_AI, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createKernel, person } from './support.ts';

let k: TestKernel;
beforeEach(async () => {
	({ k } = await createKernel());
});
afterEach(() => k.close());

it('puts a note up until its last day, and becomes a draft', async () => {
	const [out] = await resolveMentions(
		k,
		'board.note',
		[
			{
				kind: 'board.note',
				notes: 'The plumber comes Thursday morning: keep the kitchen clear',
				endDate: { text: 'Thursday 8 October', weekday: 4, day: 8, month: 10 },
			},
		],
		{ text: 'Put on the board: the plumber comes Thursday 8 October, keep the kitchen clear' },
	);
	expect(out).toEqual({
		propose: {
			actionId: 'board.postNote',
			input: {
				text: 'The plumber comes Thursday morning: keep the kitchen clear',
				endsOn: '2026-10-08',
			},
			subject: 'The plumber comes Thursday morning: keep the kitchen clear',
			from: [0],
		},
	});
	if (!out || !('propose' in out)) throw new Error('expected a suggestion');
	expect((await k.runner.invoke(out.propose.actionId, out.propose.input, SHARE_AI)).status).toBe(
		'drafted',
	);
});

it('leaves out a note the board already shows, an empty one, and a last day that has passed', async () => {
	const admin = await person(k, 'admin', 'Mara');
	await k.runner.invoke('board.postNote', { text: 'Keys are under the mat' }, admin.actor);
	const out = await resolveMentions(k, 'board.note', [
		{ kind: 'board.note', notes: 'keys are under  the mat' },
		{ kind: 'board.note', endDate: { text: 'Friday', weekday: 5 } },
		{ kind: 'board.note', notes: 'Bake sale', endDate: { text: 'yesterday', inDays: -1 } },
	]);
	expect(out).toEqual([
		{ refuse: { reason: 'already', subject: 'keys are under  the mat', from: [0] } },
		{ refuse: { reason: 'incomplete', subject: null, from: [1] } },
		{
			propose: {
				actionId: 'board.postNote',
				input: { text: 'Bake sale' },
				subject: 'Bake sale',
				from: [2],
			},
		},
	]);
});
