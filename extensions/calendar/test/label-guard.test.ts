import { type Actor, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import calendar from '../src/server/index.ts';

const AI: Actor = { kind: 'ai', source: 'assistant' };
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

describe('a label that names another thing than the target', () => {
	it('refuses an AI delete or change, telling it what the target really is', async () => {
		for (const [action, extra] of [
			['calendar.deleteEvent', {}],
			['calendar.changeEvent', { location: 'Room 4' }],
		] as const) {
			await expect(
				k.runner.invoke(action, { id: eventId, label: 'Sunday planning', ...extra }, AI),
			).rejects.toMatchObject({
				message: "That handle is 'Biology test', not 'Sunday planning'. Look it up again.",
			});
		}
	});

	it('accepts labels that hold the title or are held by it, in any case and spacing', async () => {
		for (const label of ['Biology test (1 Mar)', '  biology   TEST ', 'Biology', undefined]) {
			const result = await k.runner.invoke(
				'calendar.deleteEvent',
				{ id: eventId, ...(label && { label }) },
				AI,
			);
			expect(result.status).toBe('drafted');
		}
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
