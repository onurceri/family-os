import { defineJob } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { jobLog, notesExtension } from './fixtures.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

let k: TestKernel;
beforeEach(async () => {
	jobLog.length = 0;
	k = await createTestKernel({ extensions: [notesExtension] });
});
afterEach(() => k.close());

async function runJob(payload: object) {
	await k.queue.enqueue(k.ctx.db, 'notes.process', payload, { maxAttempts: 3 });
	expect(await k.worker.drain()).toBe(1);
}

describe('worker', () => {
	it('runs jobs enqueued by actions after commit', async () => {
		const { actor } = await k.member('admin');
		const result = await k.runner.invoke<{ id: string }>(
			'notes.addNote',
			{ body: 'x', withJob: true },
			actor,
		);
		if (result.status !== 'applied') throw new Error('expected applied');
		expect(await k.worker.drain()).toBe(1);
		expect(jobLog).toEqual([`${result.output.id}#1`]);
	});

	it("stores the job definition's maxAttempts when enqueued from an action", async () => {
		const { actor } = await k.member('admin');
		await k.runner.invoke('notes.addNote', { body: 'x', withJob: true }, actor);
		const job = await k.queue.claim(['notes.process'], 1000);
		expect(job?.maxAttempts).toBe(3);
	});

	it('retries with backoff and gives up after maxAttempts', async () => {
		await runJob({ id: 'a', fail: 99 });
		expect(await k.worker.drain()).toBe(0); // backing off
		for (let i = 0; i < 2; i++) {
			k.clock.advance(1000);
			expect(await k.worker.drain()).toBe(1);
		}
		k.clock.advance(1000);
		expect(await k.worker.drain()).toBe(0); // dead after 3 attempts
		expect(jobLog).toEqual(['a#1', 'a#2', 'a#3']);
	});

	it('succeeds on a later attempt', async () => {
		await runJob({ id: 'b', fail: 1 });
		k.clock.advance(1000);
		expect(await k.worker.drain()).toBe(1);
		k.clock.advance(1000);
		expect(await k.worker.drain()).toBe(0);
		expect(jobLog).toEqual(['b#1', 'b#2']);
	});

	it('times out hanging jobs and retries them', async () => {
		await runJob({ id: 'h', hang: true });
		k.clock.advance(1000);
		expect(await k.worker.drain()).toBe(1);
		expect(jobLog).toEqual(['h#1', 'h#2']);
	});

	it('wakes up immediately when an action enqueues a job', async () => {
		const { actor } = await k.member('admin');
		k.worker.start();
		await k.runner.invoke('notes.addNote', { body: 'x', withJob: true }, actor);
		await new Promise((r) => setTimeout(r, 50));
		await k.worker.stop();
		expect(jobLog).toHaveLength(1);
	});
});

describe('lanes', () => {
	it('runs a default job to completion while a long job is in progress', async () => {
		const events: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slow = defineJob({
			name: 'lanes.slow',
			payload: z.object({}),
			lane: 'long',
			timeoutMs: 10_000,
			async handle(ctx) {
				// Uses the shared connection (a transaction), then stays in progress.
				await ctx.db.transaction().execute(async (trx) => {
					await trx.selectNoFrom((eb) => eb.val(1).as('one')).execute();
				});
				events.push('slow:started');
				await gate;
				events.push('slow:done');
			},
		});
		const quick = defineJob({
			name: 'lanes.quick',
			payload: z.object({}),
			async handle(ctx) {
				await ctx.db.transaction().execute(async (trx) => {
					await trx.selectNoFrom((eb) => eb.val(1).as('one')).execute();
				});
				events.push('quick:done');
			},
		});
		const lanes = await createTestKernel({
			extensions: [defineTestExtension({ id: 'lanes', jobs: [slow, quick] })],
		});
		try {
			await lanes.queue.enqueue(lanes.ctx.db, 'lanes.slow', {});
			lanes.worker.start();
			await vi.waitFor(() => expect(events).toContain('slow:started'));

			await lanes.queue.enqueue(lanes.ctx.db, 'lanes.quick', {});
			lanes.worker.wake();
			await vi.waitFor(() => expect(events).toContain('quick:done'));
			expect(events).not.toContain('slow:done');

			release();
			await lanes.worker.stop();
			expect(events).toEqual(['slow:started', 'quick:done', 'slow:done']);
			// Both are finished, not left leased.
			expect(await lanes.worker.drain()).toBe(0);
		} finally {
			release();
			await lanes.close();
		}
	});

	it('drains both lanes', async () => {
		const ran: string[] = [];
		const a = defineJob({
			name: 'lanes.a',
			payload: z.object({}),
			async handle() {
				ran.push('a');
			},
		});
		const b = defineJob({
			name: 'lanes.b',
			payload: z.object({}),
			lane: 'long',
			async handle() {
				ran.push('b');
			},
		});
		const lanes = await createTestKernel({
			extensions: [defineTestExtension({ id: 'lanes', jobs: [a, b] })],
		});
		try {
			await lanes.queue.enqueue(lanes.ctx.db, 'lanes.a', {});
			await lanes.queue.enqueue(lanes.ctx.db, 'lanes.b', {});
			expect(await lanes.worker.drain()).toBe(2);
			expect(ran.sort()).toEqual(['a', 'b']);
		} finally {
			await lanes.close();
		}
	});
});

describe('a job that runs past its timeout', () => {
	const make = async (jobs: ReturnType<typeof defineJob>[], abortGraceMs = 30_000) =>
		createTestKernel({
			extensions: [defineTestExtension({ id: 'slow', jobs })],
			worker: { abortGraceMs },
		});

	it('is aborted, and its retry waits until the first attempt has stopped', async () => {
		const events: string[] = [];
		const job = defineJob({
			name: 'slow.work',
			payload: z.object({}),
			timeoutMs: 20,
			maxAttempts: 2,
			backoff: () => 0,
			async handle(_ctx, _payload, run) {
				events.push(`start#${run.attempt}`);
				if (run.attempt > 1) return;
				await new Promise<void>((resolve) =>
					run.signal.addEventListener('abort', () => resolve(), { once: true }),
				);
				// Cleaning up after the abort takes a moment; the retry must not begin meanwhile.
				await new Promise((resolve) => setTimeout(resolve, 60));
				events.push('stopped#1');
			},
		});
		const kernel = await make([job]);
		try {
			await kernel.queue.enqueue(kernel.ctx.db, 'slow.work', {});
			expect(await kernel.worker.drain()).toBe(2);
			expect(events).toEqual(['start#1', 'stopped#1', 'start#2']);
		} finally {
			await kernel.close();
		}
	});

	it('is retried once its grace has passed when it ignores the abort', async () => {
		const events: string[] = [];
		const job = defineJob({
			name: 'slow.stuck',
			payload: z.object({}),
			timeoutMs: 20,
			maxAttempts: 2,
			backoff: () => 0,
			async handle(_ctx, _payload, run) {
				events.push(`start#${run.attempt}`);
				if (run.attempt === 1) await new Promise(() => {});
			},
		});
		const kernel = await make([job], 30);
		try {
			await kernel.queue.enqueue(kernel.ctx.db, 'slow.stuck', {});
			expect(await kernel.worker.drain()).toBe(2);
			expect(events).toEqual(['start#1', 'start#2']);
		} finally {
			await kernel.close();
		}
	});

	it('holds a lease of its own timeout, not of the longest job in the lane', async () => {
		let started = false;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const quick = defineJob({
			name: 'slow.quick',
			payload: z.object({}),
			timeoutMs: 1000,
			async handle() {
				started = true;
				await gate;
			},
		});
		const longest = defineJob({
			name: 'slow.longest',
			payload: z.object({}),
			timeoutMs: 600_000,
			async handle() {},
		});
		const kernel = await make([quick, longest], 500);
		try {
			await kernel.queue.enqueue(kernel.ctx.db, 'slow.quick', {});
			const draining = kernel.worker.drain();
			await vi.waitFor(() => expect(started).toBe(true));
			kernel.clock.advance(1499);
			expect(await kernel.queue.recoverExpired()).toBe(0);
			kernel.clock.advance(2);
			expect(await kernel.queue.recoverExpired()).toBe(1);
			release();
			await draining;
		} finally {
			release();
			await kernel.close();
		}
	});
});
