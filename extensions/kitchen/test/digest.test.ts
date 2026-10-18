import { type Actor, type DigestOutput, type MemberId, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import kitchen from '../src/server/index.ts';

let k: TestKernel;
let mara: Awaited<ReturnType<TestKernel['member']>>;
let leo: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [kitchen] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: 'UTC' }, systemActor('test'));
	mara = await k.member('admin');
	leo = await k.member('supervised');
});
afterEach(() => k.close());

const ai = (m = mara, roleId = 'admin'): Actor => ({
	kind: 'ai',
	mode: 'conversation',
	source: 'assistant',
	onBehalfOf: m.member.id as MemberId,
	roleId,
});
const plan = (input: Record<string, unknown>) =>
	k.runner.invoke('kitchen.addToMealPlan', input, mara.actor);
const digest = async (input: Record<string, unknown>, actor: Actor = ai()) => {
	const result = await k.runner.invoke<DigestOutput>('kitchen.digest', input, actor);
	if (result.status !== 'applied') throw new Error('expected a read');
	return result.output;
};

describe('kitchen.digest', () => {
	it('holds the meals of the span in day and slot order, with their notes', async () => {
		await plan({ date: '2026-01-04', title: 'Before' });
		await plan({ date: '2026-01-05', slot: 'dinner', title: 'Soup', note: 'Use the leeks' });
		await plan({ date: '2026-01-05', slot: 'breakfast', title: 'Pancakes' });
		await plan({ date: '2026-01-11', title: 'Roast' });
		await plan({ date: '2026-01-12', title: 'After' });
		const out = await digest({ from: '2026-01-05', to: '2026-01-11' });
		expect(out.items.map((i) => `${i.date} ${i.title}`)).toEqual([
			'2026-01-05 Pancakes',
			'2026-01-05 Soup',
			'2026-01-11 Roast',
		]);
		expect(out.items[1]).toMatchObject({
			kind: 'meal',
			handle: expect.stringMatching(/^meal_/),
			notes: 'Use the leeks',
			people: [],
			extra: { slot: 'dinner' },
		});
	});

	it('never leaves a meal out for the people asked about, and ranks by the words', async () => {
		await plan({ date: '2026-01-05', title: 'Soup' });
		await plan({ date: '2026-01-06', title: 'Fish and chips' });
		const out = await digest({
			from: '2026-01-05',
			to: '2026-01-06',
			memberIds: [leo.member.id],
			about: ['fish'],
		});
		expect(out.items.map((i) => i.title)).toEqual(['Fish and chips', 'Soup']);
	});

	it('has nothing for a day with no meal planned, and says what is planned next', async () => {
		// "What is for dinner on Friday?" with a dinner elsewhere: that is the calendar's event,
		// not a meal of the plan.
		await plan({ date: '2026-02-14', title: 'Lasagne' });
		const out = await digest({ from: '2026-01-09', to: '2026-01-09' });
		expect(out.items).toEqual([]);
		expect(out.nextAfter).toMatchObject({ title: 'Lasagne', date: '2026-02-14' });
	});

	it('cuts a crowded span and says so', async () => {
		for (let day = 1; day <= 31; day++) {
			const date = `2026-01-${String(day).padStart(2, '0')}`;
			await plan({ date, slot: 'lunch', title: 'Lunch' });
			await plan({ date, slot: 'dinner', title: 'Dinner' });
		}
		const out = await digest({ from: '2026-01-01', to: '2026-01-31' });
		expect(out.items).toHaveLength(60);
		expect(out.truncated).toBe(true);
	});

	it('gives nothing to an AI whose area is off', async () => {
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'kitchen', access: 'off' },
			mara.actor,
		);
		await expect(
			k.runner.invoke('kitchen.digest', { from: '2026-01-01', to: '2026-01-07' }, ai()),
		).rejects.toMatchObject({ code: 'forbidden' });
	});
});

describe('kitchen.digest links', () => {
	it('opens the meal plan on the week of the meal', async () => {
		await plan({ date: '2026-01-06', title: 'Soup' });
		const out = await digest({ from: '2026-01-05', to: '2026-01-11' });
		expect(out.items[0]?.href).toBe('/kitchen/plan?date=2026-01-06');
	});
});
