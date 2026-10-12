import { type MemberId, systemActor } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestKernel, type TestKernel } from './harness.ts';

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel();
});
afterEach(() => k.close());

describe('core.today', () => {
	it('tells the date, weekday, time and this week in the family time zone', async () => {
		// Saturday 2026-10-10, 23:30 in Istanbul is still 20:30 in UTC.
		const target = Date.parse('2026-10-10T20:30:00Z');
		k.clock.advance(target - k.clock.now());
		await k.runner.invoke(
			'core.updateFamilySettings',
			{ timeZone: 'Europe/Istanbul', weekStart: 1 },
			systemActor('test'),
		);
		const { actor } = await k.member('member');
		const result = await k.runner.invoke('core.today', {}, actor);
		expect(result).toEqual({
			status: 'applied',
			output: {
				date: '2026-10-10',
				weekday: 'Saturday',
				time: '23:30',
				timeZone: 'Europe/Istanbul',
				weekFirstDay: '2026-10-05',
				weekLastDay: '2026-10-11',
			},
		});
	});

	it('follows the family’s first day of the week', async () => {
		k.clock.advance(Date.parse('2026-10-10T12:00:00Z') - k.clock.now());
		await k.runner.invoke(
			'core.updateFamilySettings',
			{ timeZone: 'UTC', weekStart: 7 },
			systemActor('test'),
		);
		const { actor } = await k.member('member');
		const result = await k.runner.invoke<{ weekFirstDay: string; weekLastDay: string }>(
			'core.today',
			{},
			actor,
		);
		expect(result).toMatchObject({
			output: { weekFirstDay: '2026-10-04', weekLastDay: '2026-10-10' },
		});
	});

	it('is offered to the assistant and MCP as a read tool', async () => {
		const { member } = await k.member('member');
		const ai = {
			kind: 'ai',
			source: 'assistant',
			onBehalfOf: member.id as MemberId,
			roleId: 'member',
		} as const;
		expect(k.ctx.actions.aiReadTools({ actor: ai }).map((a) => a.id)).toContain('core.today');
		const run = await k.runner.invoke('core.today', {}, ai);
		expect(run.status).toBe('applied');
	});
});
