import type { z } from 'zod';
import type { ExtensionContext, UnitOfWork } from './context.ts';
import type { LlmPort } from './llm.ts';
import type { EnqueueOptions } from './ports.ts';

/** What a job handler gets: the extension context plus model access. */
export interface JobContext extends ExtensionContext {
	readonly llm: LlmPort;
	/**
	 * Writes the extension's own tables outside an action (clearing what has expired, replacing
	 * what a feed holds) in one transaction, as the system. It is the same unit of work an action
	 * gets: events emitted in it are kept in the change log with the data, and fire after the
	 * commit. A job that changes what apps may read goes through it, not through `ctx.db`.
	 */
	unit<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T>;
}

// The SDK compiles without DOM or Node types; this gives `AbortSignal` a name here and merges with
// the full global type wherever one is loaded.
declare global {
	interface AbortSignal {
		readonly aborted: boolean;
	}
}

export type JobLane = 'default' | 'long';

export interface JobRun {
	readonly id: string;
	readonly attempt: number;
	readonly maxAttempts: number;
	/**
	 * Aborted when the attempt passes its `timeoutMs`. A handler passes it to what it waits on
	 * (a model call, a request) and stops writing once it is aborted: the worker starts no retry
	 * before this attempt has stopped or its lease has run out.
	 */
	readonly signal: AbortSignal;
}

/**
 * A background job. Handlers MUST be idempotent: a job can run more than once after a crash or
 * a timeout. Persist results before enqueuing follow-up work.
 */
export interface JobDefinition<
	Name extends string = string,
	Payload extends z.ZodType = z.ZodType,
> {
	readonly name: Name;
	readonly payload: Payload;
	/** Hard limit for one attempt. LLM calls must set an explicit timeout. */
	readonly timeoutMs: number;
	readonly maxAttempts: number;
	/**
	 * The worker runs one job at a time per lane. Jobs that can take minutes (uploads) use `long`
	 * so they do not delay reminders and notifications on the `default` lane.
	 */
	readonly lane: JobLane;
	/** Delay before attempt `n + 1` (n starts at 1). */
	backoff(attempt: number): number;
	handle(ctx: JobContext, payload: z.infer<Payload>, run: JobRun): Promise<void>;
}

const JOB_NAME = /^[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9.]*$/;

export function defineJob<const Name extends string, Payload extends z.ZodType>(definition: {
	name: Name;
	payload: Payload;
	timeoutMs?: number;
	maxAttempts?: number;
	lane?: JobLane;
	backoff?: (attempt: number) => number;
	handle(ctx: JobContext, payload: z.infer<Payload>, run: JobRun): Promise<void>;
}): JobDefinition<Name, Payload> {
	if (!JOB_NAME.test(definition.name)) {
		throw new Error(
			`Invalid job name "${definition.name}": use "<extension>.<step>", e.g. "inbox.normalize"`,
		);
	}
	return {
		timeoutMs: 60_000,
		maxAttempts: 5,
		lane: 'default',
		backoff: (attempt) => Math.min(2 ** attempt * 1000, 15 * 60_000),
		...definition,
	};
}

// biome-ignore lint/suspicious/noExplicitAny: registries hold heterogeneous job types.
export type AnyJobDefinition = JobDefinition<string, any>;

export type { EnqueueOptions };
