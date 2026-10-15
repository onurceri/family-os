import { type Actor, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import calendar from '../src/server/index.ts';
import { changeEventFields } from '../src/web/change.ts';

// A change card reads "old → new": the server sends what the fields it changes hold now.
const TZ = 'Europe/Istanbul';
let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-14', '09:00', TZ));
	admin = await k.member('admin', 'Ayse');
});
afterEach(() => k.close());

const context = {
	t: (key: string) => key,
	members: [] as { id: string; displayName: string; color: string }[],
	formatLocale: 'en-GB',
	dateLocale: 'en-GB',
	weekStart: 1,
	hourCycle: 'h23' as const,
	timeZone: TZ,
};
const add = async (input: object) => {
	const result = await k.runner.invoke<{ id: string }>('calendar.createEvent', input, admin.actor);
	if (result.status !== 'applied') throw new Error('expected an event');
	return result.output.id;
};
const propose = async (actionId: string, input: object, actor: Actor) => {
	const result = await k.runner.invoke(actionId, input, actor);
	if (result.status !== 'drafted') throw new Error('expected a draft');
	return result.draftId;
};
type Listed = { id: string; status: string; before: Record<string, unknown> | null };
const listed = async (id: string, status?: string): Promise<Listed> =>
	(
		(await k.route('core.listDrafts').call({
			actor: admin.actor,
			query: { limit: 20, ...(status && { status }) },
		})) as Listed[]
	).find((d) => d.id === id) as Listed;
const ai = (source: 'assistant' | 'mcp'): Actor =>
	({
		kind: 'ai',
		mode: source === 'assistant' ? 'conversation' : 'agent',
		source,
		onBehalfOf: admin.member.id,
		roleId: 'admin',
	}) as Actor;

describe('the event as it is now, on a change suggestion', () => {
	it('comes with the move offered for a new event, and the card reads old → new', async () => {
		const id = await add({ title: 'Regional Gala', date: '2026-11-07', startTime: '07:45' });
		// What a real model proposed for "the gala moved to the 14th, 9 am, at Zwembad De Kuip".
		const draftId = await propose(
			'calendar.createEvent',
			{
				title: 'Regional gala',
				date: '2026-11-14',
				startTime: '09:00',
				location: 'Zwembad De Kuip',
			},
			{ kind: 'ai', mode: 'share', source: 'inbox' },
		);
		// A new event is not a change: nothing to compare with.
		expect((await listed(draftId)).before).toBeNull();

		const replaced = (await k
			.route('core.replaceDraft')
			.call({ actor: admin.actor, params: { draftId } })) as Listed & {
			input: Record<string, unknown>;
		};
		expect(replaced.input.id).toBe(id);
		expect(replaced.before).toEqual({
			allDay: false,
			date: '2026-11-07',
			endDate: null,
			startTime: '07:45',
			endTime: '08:45',
			location: null,
		});
		const fields = changeEventFields(replaced.input as never, context, replaced.before);
		expect(fields.map((f) => [f.label, f.value])).toEqual([
			['calendar:when', 'Sat 7 Nov 07:45 → Sat 14 Nov 09:00'],
			['calendar:where', '— → Zwembad De Kuip'],
		]);
		expect((await listed(draftId)).before).toEqual(replaced.before);
	});

	it('says only the new time for one date of a repeating event moved within its day', async () => {
		const id = await add({
			title: 'Sunday planning',
			date: '2026-10-18',
			startTime: '20:00',
			endTime: '21:00',
			recurrence: { freq: 'weekly', byDay: ['SU'] },
		});
		const input = { id, label: 'Sunday planning', occurrence: '2026-10-25', startTime: '18:00' };
		const draftId = await propose('calendar.changeEvent', input, ai('assistant'));
		const { before } = await listed(draftId);
		expect(before).toMatchObject({ date: '2026-10-25', startTime: '20:00', endTime: '21:00' });
		const [when] = changeEventFields(input, context, before);
		expect(when?.value).toBe('Sun 25 Oct 20:00 → 18:00');
	});

	it('shows the old title and place for a connected app, and nothing once decided', async () => {
		const id = await add({
			title: 'Dentist',
			date: '2026-10-20',
			startTime: '10:00',
			location: 'Main St',
		});
		const input = { id, label: 'Dentist', title: 'Dentist check-up', location: 'Harbour clinic' };
		const draftId = await propose('calendar.changeEvent', input, ai('mcp'));
		const { before } = await listed(draftId);
		expect(before).toEqual({ title: 'Dentist', location: 'Main St' });
		expect(changeEventFields(input, context, before).map((f) => f.value)).toEqual([
			'Dentist → Dentist check-up',
			'Main St → Harbour clinic',
		]);

		await k.runner.approveDraft(draftId, admin.actor);
		expect((await listed(draftId, 'applied')).before).toBeNull();
	});

	it('is null when the event is gone', async () => {
		const id = await add({ title: 'Piano', date: '2026-10-21', startTime: '17:00' });
		const draftId = await propose(
			'calendar.changeEvent',
			{ id, label: 'Piano', startTime: '18:00' },
			ai('assistant'),
		);
		await k.runner.invoke('calendar.deleteEvent', { id }, admin.actor);
		expect((await listed(draftId)).before).toBeNull();
	});
});

describe('changeEventFields without the event as it is', () => {
	it('lists the new values alone', () => {
		expect(
			changeEventFields(
				{ id: 'x', label: 'Dentist', date: '2026-10-20', startTime: '10:00', location: 'Clinic' },
				context,
			).map((f) => f.value),
		).toEqual(['Tuesday 20 October · 10:00', 'Clinic']);
	});
});
