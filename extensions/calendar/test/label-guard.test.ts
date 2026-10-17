import { type Actor, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import calendar from '../src/server/index.ts';

const AI: Actor = { kind: 'ai', mode: 'conversation', source: 'assistant' };
let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
let eventId: string;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: 'UTC' }, systemActor('test'));
	admin = await k.member('admin', 'Ayse');
	const made = await k.runner.invoke<{ id: string }>(
		'calendar.createEvent',
		{ title: 'Biology test', date: '2099-03-01', startTime: '09:00' },
		admin.actor,
	);
	if (made.status !== 'applied') throw new Error('expected applied');
	eventId = made.output.id;
});
afterEach(() => k.close());

const draftInput = async (draftId: string) => {
	const row = await k.ctx.db
		.withTables<{ core_drafts: { id: string; input: string } }>()
		.selectFrom('core_drafts')
		.select('input')
		.where('id', '=', draftId)
		.executeTakeFirstOrThrow();
	return JSON.parse(row.input) as Record<string, unknown>;
};

describe('the words an AI uses for a thing must name it', () => {
	it('refuses an AI delete or change whose words name another thing, telling it what the target is', async () => {
		for (const [action, extra] of [
			['calendar.deleteEvent', {}],
			['calendar.changeEvent', { location: 'Room 4' }],
		] as const) {
			await expect(
				k.runner.invoke(action, { id: eventId, label: 'Sunday planning', ...extra }, AI),
			).rejects.toMatchObject({
				message: expect.stringContaining(
					"That is 'Biology test', not 'Sunday planning'. Tell the person this and do not suggest anything else for it.",
				),
			});
		}
	});

	it('refuses the closest real event when the named one does not exist', async () => {
		// Real mistakes: "Change Dental cleaning to 10:00" was sent for "Dentist checkup" with that
		// event's own title as the label; "Move the Delft board meeting" went to "Delft project
		// call" with no label at all.
		const dentist = await k.runner.invoke<{ id: string }>(
			'calendar.createEvent',
			{ title: 'Dentist checkup', date: '2099-10-14', startTime: '09:00' },
			admin.actor,
		);
		if (dentist.status !== 'applied') throw new Error('expected applied');
		await expect(
			k.runner.invoke(
				'calendar.changeEvent',
				{ id: dentist.output.id, startTime: '10:00', label: 'Dental cleaning' },
				AI,
			),
		).rejects.toMatchObject({ message: expect.stringContaining("not 'Dental cleaning'") });
		await expect(
			k.runner.invoke(
				'calendar.changeEvent',
				{ id: dentist.output.id, startTime: '10:00', label: 'Dentist checkup (14 Oct)' },
				AI,
			),
		).resolves.toMatchObject({ status: 'drafted' });
		await expect(
			k.runner.invoke('calendar.changeEvent', { id: dentist.output.id, startTime: '10:00' }, AI),
		).rejects.toMatchObject({ message: expect.stringContaining('Say which one you mean') });
	});

	it('accepts words that are all in the title, in any case, spacing or plural', async () => {
		for (const label of ['  biology   TEST ', 'Biology', 'biology tests', 'Biology test (1 Mar)']) {
			const result = await k.runner.invoke('calendar.deleteEvent', { id: eventId, label }, AI);
			expect(result.status).toBe('drafted');
		}
	});

	it('stores the real title as the label of every draft, whoever proposed it', async () => {
		const byAi = await k.runner.invoke(
			'calendar.deleteEvent',
			{ id: eventId, label: 'biology' },
			AI,
		);
		if (byAi.status !== 'drafted') throw new Error('expected a draft');
		expect(await draftInput(byAi.draftId)).toMatchObject({ id: eventId, label: 'Biology test' });
		// A screen sends only the id; a supervised member's change waits for approval.
		const supervised = await k.member('supervised', 'Mina');
		const byPerson = await k.runner.invoke(
			'calendar.deleteEvent',
			{ id: eventId },
			supervised.actor,
		);
		if (byPerson.status !== 'drafted') throw new Error('expected a draft');
		expect(await draftInput(byPerson.draftId)).toMatchObject({ label: 'Biology test' });
	});

	it('does not judge people, who see what they pick', async () => {
		const result = await k.runner.invoke(
			'calendar.deleteEvent',
			{ id: eventId, label: 'Sunday planning' },
			admin.actor,
		);
		expect(result.status).toBe('applied');
	});
});

describe('a change that changes nothing', () => {
	it('is refused as already so, when the AI sends what the event already is', async () => {
		// Real case: a school letter repeated the evening's date and time, and the model proposed
		// changing the listed evening to exactly that.
		await expect(
			k.runner.invoke(
				'calendar.changeEvent',
				{ id: eventId, label: 'Biology test', date: '2099-03-01', startTime: '09:00' },
				AI,
			),
		).rejects.toMatchObject({
			code: 'conflict',
			message: expect.stringContaining('Biology test is already like that'),
			details: { refused: 'settled', subject: 'Biology test' },
		});
		const moved = await k.runner.invoke(
			'calendar.changeEvent',
			{ id: eventId, label: 'Biology test', date: '2099-03-01', startTime: '10:00' },
			AI,
		);
		expect(moved.status).toBe('drafted');
	});
});
