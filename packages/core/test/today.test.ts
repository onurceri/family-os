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
				thisWeek: { from: '2026-10-10', to: '2026-10-11' },
				thisWeekNote: null,
				nextWeek: { from: '2026-10-12', to: '2026-10-18' },
				days: expect.arrayContaining(['Sat 2026-10-10 (today)', 'Sun 2026-10-11 (tomorrow)']),
			},
		});
	});

	it('answers the family’s day just after midnight in a zone ahead of UTC', async () => {
		// Tuesday 2026-10-13, 00:30 in Istanbul is still Monday 21:30 in UTC.
		k.clock.advance(Date.parse('2026-10-12T21:30:00Z') - k.clock.now());
		await k.runner.invoke(
			'core.updateFamilySettings',
			{ timeZone: 'Europe/Istanbul', weekStart: 1 },
			systemActor('test'),
		);
		const { actor } = await k.member('member');
		const result = await k.runner.invoke<{
			date: string;
			weekday: string;
			time: string;
			days: string[];
		}>('core.today', {}, actor);
		if (result.status !== 'applied') throw new Error('expected an answer');
		expect(result.output).toMatchObject({ date: '2026-10-13', weekday: 'Tuesday', time: '00:30' });
		expect(result.output.days[0]).toBe('Tue 2026-10-06');
		expect(result.output.days).toContain('Mon 2026-10-12 (yesterday)');
		expect(result.output.days).toContain('Tue 2026-10-13 (today)');
		expect(result.output.days).toContain('Tue 2026-10-20');
		expect(result.output.days.at(-1)).toBe('Tue 2026-10-27');
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

	it('says what "this week" means on the week’s last day, whichever day the week starts on', async () => {
		// Saturday 2026-10-10 ends a week that starts on Sunday; Sunday 2026-10-11 ends a Monday week.
		for (const [at, weekStart, thisWeek, nextWeek, noted] of [
			['2026-10-10T12:00:00Z', 7, ['2026-10-10', '2026-10-16'], ['2026-10-11', '2026-10-17'], true],
			['2026-10-11T12:00:00Z', 1, ['2026-10-11', '2026-10-17'], ['2026-10-12', '2026-10-18'], true],
			[
				'2026-10-11T12:00:00Z',
				7,
				['2026-10-11', '2026-10-17'],
				['2026-10-18', '2026-10-24'],
				false,
			],
		] as const) {
			k.clock.advance(Date.parse(at) - k.clock.now());
			await k.runner.invoke(
				'core.updateFamilySettings',
				{ timeZone: 'UTC', weekStart },
				systemActor('test'),
			);
			const { actor } = await k.member('member');
			const result = await k.runner.invoke<{
				thisWeek: { from: string; to: string };
				nextWeek: { from: string; to: string };
				thisWeekNote: string | null;
			}>('core.today', {}, actor);
			if (result.status !== 'applied') throw new Error('expected an answer');
			expect(result.output.thisWeek).toEqual({ from: thisWeek[0], to: thisWeek[1] });
			expect(result.output.nextWeek).toEqual({ from: nextWeek[0], to: nextWeek[1] });
			expect(result.output.thisWeekNote !== null).toBe(noted);
		}
	});

	it('is offered to the assistant and MCP as a read tool', async () => {
		const { member } = await k.member('member');
		const ai = {
			kind: 'ai',
			mode: 'conversation',
			source: 'assistant',
			onBehalfOf: member.id as MemberId,
			roleId: 'member',
		} as const;
		expect(k.ctx.actions.aiReadTools({ actor: ai }).map((a) => a.id)).toContain('core.today');
		const run = await k.runner.invoke('core.today', {}, ai);
		expect(run.status).toBe('applied');
	});
});
