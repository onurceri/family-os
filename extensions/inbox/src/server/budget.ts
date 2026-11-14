import { READ_ATTEMPTS } from '../contract/index.ts';

/**
 * The time one reading of an item may take. A reading transcribes the voice notes (one window
 * shared by all of them), then asks the model once; the job's limit is the sum of those steps
 * and some room for the writes around them, so a slow model is cut off by its own timeout,
 * never by the job's.
 */
export const TRANSCRIBE_BUDGET_MS = 120_000;
export const EXTRACT_TIMEOUT_MS = 90_000;
const READ_SLACK_MS = 15_000;

export const READ_TIMEOUT_MS = TRANSCRIBE_BUDGET_MS + EXTRACT_TIMEOUT_MS + READ_SLACK_MS;

/** The pause before the next try of a reading (`attempt` starts at 1). */
export const readBackoff = (attempt: number) => Math.min(30_000 * 2 ** (attempt - 1), 10 * 60_000);

/**
 * The time a reading may wait in the queue before it starts: it shares its lane with other jobs
 * that run for minutes, a backup upload the longest of them, so the wait is counted generously.
 */
const READ_QUEUE_WAIT_MS = 60 * 60_000;

/**
 * How long after it last changed an item can still be in the hands of its reading: every attempt,
 * the pauses between them and the wait in the queue. An item still unread after that was left by
 * a job that ended without telling anyone (the server stopped on its last attempt).
 */
export const READ_MAX_LIFE_MS =
	READ_ATTEMPTS * READ_TIMEOUT_MS +
	Array.from({ length: READ_ATTEMPTS - 1 }, (_, i) => readBackoff(i + 1)).reduce(
		(sum, ms) => sum + ms,
		0,
	) +
	READ_QUEUE_WAIT_MS;
/** How often items left unread are looked for. */
export const SWEEP_EVERY_MS = 10 * 60_000;
