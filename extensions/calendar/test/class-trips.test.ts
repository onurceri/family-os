import { systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import calendar from '../src/server/index.ts';

const TZ = 'Europe/Istanbul';
const ai = { kind: 'ai', mode: 'share', source: 'inbox' } as const;
let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-14', '09:00', TZ));
	admin = await k.member('admin');
	await k.runner.invoke(
		'calendar.createEvent',
		{ title: 'Class 1B trip to Bled', date: '2026-10-30', startTime: '08:10' },
		admin.actor,
	);
});
afterEach(() => k.close());

type Listed = { id: string; mayExist: boolean; instead: { actionId: string } | null };
async function propose(input: object): Promise<Listed | undefined> {
	const result = await k.runner.invoke('calendar.createEvent', input, ai);
	if (result.status !== 'drafted') throw new Error('expected a draft');
	const drafts = (await k
		.route('core.listDrafts')
		.call({ actor: admin.actor, query: { limit: 20 } })) as Listed[];
	return drafts.find((d) => d.id === result.draftId);
}

// Found in use: Ivy's "8.B trip to bled" and Mara's "Class 3B trip" were offered as a move of
// Leo's "Class 1B trip to Bled".
describe('another class with the same kind of trip', () => {
	it.each(['8.B trip to bled on thu 29.10', 'Class 3B trip to Bled'])(
		'is a new event, not a move of the other class: %s',
		async (title) => {
			const draft = await propose({ title, date: '2026-10-29', startTime: '08:00' });
			expect(draft?.instead).toBeNull();
			expect(draft?.mayExist).toBe(false);
		},
	);

	it('still finds the same class trip by its code', async () => {
		const draft = await propose({
			title: '1B trip to Bled',
			date: '2026-10-31',
			startTime: '08:10',
		});
		expect(draft?.instead).toMatchObject({ actionId: 'calendar.changeEvent' });
	});
});
