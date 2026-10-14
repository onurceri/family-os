import type { Clock, JobContext, JobLane, JobQueue, Logger } from '@famos/sdk';
import { ownerOf } from './features.ts';
import type { Registry } from './registry.ts';

export interface WorkerOptions {
	/** Poll interval when the queue is empty. */
	idleMs?: number;
	/** How often expired leases are returned to the queue. */
	recoverEveryMs?: number;
}

export interface Worker {
	start(): void;
	/** Stops polling and waits for the jobs in progress, if any. */
	stop(): Promise<void>;
	/** Wakes the loop immediately (called after a commit that enqueued jobs). */
	wake(): void;
	/** Processes due jobs until none are left; for tests and the CLI. */
	drain(): Promise<number>;
}

const LANES: readonly JobLane[] = ['default', 'long'];

class JobTimeoutError extends Error {
	constructor(name: string, ms: number) {
		super(`Job ${name} timed out after ${ms} ms`);
		this.name = 'JobTimeoutError';
	}
}

export function createWorker(deps: {
	queue: JobQueue;
	registry: Registry;
	/** The context a job's handler gets: its extension's own, by the job's name. */
	ctxFor: (job: string) => JobContext;
	clock: Clock;
	logger: Logger;
	/** Jobs of turned-off extensions stay queued until it is turned on again. */
	isOn?: (extensionId: string) => boolean;
	options?: WorkerOptions;
}): Worker {
	const { queue, registry, clock } = deps;
	const logger = deps.logger.child({ component: 'worker' });
	const idleMs = deps.options?.idleMs ?? 1000;
	const recoverEveryMs = deps.options?.recoverEveryMs ?? 30_000;
	const defs = [...registry.jobs.values()];
	const maxLease = Math.max(60_000, ...defs.map((j) => j.timeoutMs + 30_000));
	const namesOf = (lane: JobLane) => defs.filter((j) => j.lane === lane).map((j) => j.name);

	let running = false;
	let lastRecover = 0;

	async function recoverIfDue() {
		if (clock.now() - lastRecover < recoverEveryMs) return;
		lastRecover = clock.now();
		const recovered = await queue.recoverExpired();
		if (recovered > 0) logger.warn({ recovered }, 'recovered expired job leases');
	}

	/** Runs one job of a lane if available. Returns false when the lane had nothing due. */
	async function step(lane: JobLane): Promise<boolean> {
		await recoverIfDue();
		const isOn = deps.isOn ?? (() => true);
		const active = namesOf(lane).filter((name) => isOn(ownerOf(name)));
		if (active.length === 0) return false;
		const job = await queue.claim(active, maxLease);
		if (!job) return false;

		const def = registry.jobs.get(job.name);
		const log = logger.child({ job: job.name, jobId: job.id, attempt: job.attempt });
		if (!def) {
			await queue.fail(job.id, `No handler for job "${job.name}"`, clock.now() + 60_000);
			return true;
		}
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const payload = def.payload.parse(job.payload);
			await Promise.race([
				def.handle(deps.ctxFor(job.name), payload, {
					id: job.id,
					attempt: job.attempt,
					maxAttempts: job.maxAttempts,
				}),
				new Promise<never>((_, reject) => {
					timeout = setTimeout(
						() => reject(new JobTimeoutError(job.name, def.timeoutMs)),
						def.timeoutMs,
					);
				}),
			]);
			await queue.complete(job.id);
			log.debug({}, 'job succeeded');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const state = await queue.fail(job.id, message, clock.now() + def.backoff(job.attempt));
			log[state === 'dead' ? 'error' : 'warn']({ err: error, state }, 'job failed');
		} finally {
			clearTimeout(timeout);
		}
		return true;
	}

	/**
	 * One loop per lane, one job at a time in each. The lanes share the single SQLite connection;
	 * Kysely's driver hands it out one holder at a time (a transaction keeps it until it ends), so
	 * their queries interleave but never their transactions.
	 */
	function createLoop(lane: JobLane) {
		let busy = false;
		let wokenWhileBusy = false;
		let current: Promise<unknown> = Promise.resolve();
		let timer: ReturnType<typeof setTimeout> | undefined;

		const schedule = (ms: number) => {
			clearTimeout(timer);
			if (running) timer = setTimeout(loop, ms);
		};

		function loop() {
			if (busy) {
				wokenWhileBusy = true;
				return;
			}
			busy = true;
			current = step(lane)
				.catch((error: unknown) => {
					logger.error({ err: error, lane }, 'worker loop error');
					return false;
				})
				.then((didWork) => {
					busy = false;
					const again = didWork || wokenWhileBusy;
					wokenWhileBusy = false;
					schedule(again ? 0 : idleMs);
				});
		}

		return {
			start: () => schedule(0),
			async stop() {
				clearTimeout(timer);
				await current;
			},
			wake() {
				if (busy) wokenWhileBusy = true;
				else schedule(0);
			},
		};
	}

	const loops = LANES.map(createLoop);

	return {
		start() {
			if (running) return;
			running = true;
			logger.info({ jobs: defs.map((j) => j.name) }, 'worker started');
			for (const l of loops) l.start();
		},
		async stop() {
			running = false;
			await Promise.all(loops.map((l) => l.stop()));
		},
		wake() {
			if (!running) return;
			for (const l of loops) l.wake();
		},
		async drain() {
			// Lanes run side by side; a job in one may enqueue work for the other, so repeat until both are empty.
			let count = 0;
			for (;;) {
				const done = await Promise.all(
					LANES.map(async (lane) => {
						let n = 0;
						while (await step(lane)) n++;
						return n;
					}),
				);
				const total = done.reduce((a, b) => a + b, 0);
				if (total === 0) return count;
				count += total;
			}
		},
	};
}
