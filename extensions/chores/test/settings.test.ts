import type { Actor } from '@famos/sdk';
import type { TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applied, at, createKernel, mayCall, type Person, person } from './support.ts';

let k: TestKernel;
let ayse: Person; // admin
let bora: Person; // guest, without chores.edit

beforeEach(async () => {
	({ k } = await createKernel());
	ayse = await person(k, 'admin', 'Ayşe');
	bora = await person(k, 'guest', 'Bora');
});
afterEach(() => k.close());

const set = (times: unknown, actor = ayse.actor) =>
	k.runner.invoke('chores.setLeftTodayTimes', { times }, actor);
const code = (p: Promise<unknown>) =>
	p.then(
		() => null,
		(e: { code?: string }) => e.code ?? 'error',
	);
const read = () => k.route('chores.getSettings').call({ actor: ayse.actor });
const pending = async () =>
	(
		await k.ctx.db
			.withTables<{ queue_jobs: { name: string; status: string; run_at: number } }>()
			.selectFrom('queue_jobs')
			.select('run_at')
			.where('name', '=', 'chores.leftToday')
			.where('status', '=', 'pending')
			.execute()
	).map((r) => r.run_at);

describe('the times of the evening count', () => {
	it('reads the default, then what was saved, in order', async () => {
		expect(await read()).toEqual({ leftTodayTimes: ['18:00'] });
		expect(
			await applied(k, 'chores.setLeftTodayTimes', { times: ['20:30', '07:00'] }, ayse.actor),
		).toEqual({ leftTodayTimes: ['07:00', '20:30'] });
		expect(await read()).toEqual({ leftTodayTimes: ['07:00', '20:30'] });
		await applied(k, 'chores.setLeftTodayTimes', { times: ['19:00'] }, ayse.actor);
		expect(await read()).toEqual({ leftTodayTimes: ['19:00'] });
	});

	it('refuses none, five, a duplicate and a bad time', async () => {
		for (const times of [
			[],
			['08:00', '09:00', '10:00', '11:00', '12:00'],
			['18:00', '18:00'],
			['6pm'],
			['24:00'],
			['18:60'],
			['9:00'],
		]) {
			expect(await code(set(times))).toBe('bad_request');
		}
		expect(await read()).toEqual({ leftTodayTimes: ['18:00'] });
	});

	it('accepts four', async () => {
		await applied(
			k,
			'chores.setLeftTodayTimes',
			{ times: ['06:00', '09:00', '12:00', '18:00'] },
			ayse.actor,
		);
		expect((await read()).leftTodayTimes).toHaveLength(4);
	});

	it('is set by those who may edit chores, and read by everyone who sees chores', async () => {
		expect(await code(set(['19:00'], bora.actor))).toBe('forbidden');
		expect(mayCall(k, bora.actor, 'chores.getSettings')).toBe(true);
		expect(mayCall(k, ayse.actor, 'chores.getSettings')).toBe(true);
		expect(await k.route('chores.getSettings').call({ actor: bora.actor })).toEqual({
			leftTodayTimes: ['18:00'],
		});
	});

	it('is not read without chores.view', () => {
		const screen = (capabilities: string[]): Actor => ({
			kind: 'display',
			deviceId: 'dev_1',
			capabilities,
			showNames: true,
		});
		expect(mayCall(k, screen(['calendar.view']), 'chores.getSettings')).toBe(false);
		expect(mayCall(k, screen(['chores.view']), 'chores.getSettings')).toBe(true);
	});

	it('plans the next count at the new time', async () => {
		await applied(k, 'chores.setLeftTodayTimes', { times: ['12:00', '22:00'] }, ayse.actor);
		expect(await pending()).toContain(at('2026-10-06', '12:00'));
	});
});
