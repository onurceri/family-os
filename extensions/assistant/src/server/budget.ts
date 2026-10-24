import { MAX_PARTS } from './understand.ts';

/**
 * The time one answer may take. A turn reads the message, writes the opening words of up to
 * `MAX_PARTS` questions one after another, then runs the tool loop; the job's limit is the sum of
 * those steps, so a slow model is cut off by its own step's timeout, never by the job's.
 */
export const UNDERSTAND_TIMEOUT_MS = 60_000;
export const LEAD_TIMEOUT_MS = 45_000;
export const CHAT_TIMEOUT_MS = 120_000;
/** Reading the stored thread and writing the answer around the model calls. */
const TURN_SLACK_MS = 15_000;

export const TURN_TIMEOUT_MS =
	UNDERSTAND_TIMEOUT_MS + MAX_PARTS * LEAD_TIMEOUT_MS + CHAT_TIMEOUT_MS + TURN_SLACK_MS;
export const TURN_ATTEMPTS = 2;
export const TURN_BACKOFF_MS = 5_000;

/** The time a job may wait in the long lane behind other turns before it starts. */
const TURN_QUEUE_WAIT_MS = 10 * 60_000;

/**
 * How long after it was asked a reply can still be in the hands of its job: every attempt, the
 * pause between them and the wait for the lane. A reply open for longer was left by a job that
 * ended without telling anyone.
 */
export const TURN_MAX_LIFE_MS =
	TURN_ATTEMPTS * TURN_TIMEOUT_MS + TURN_BACKOFF_MS + TURN_QUEUE_WAIT_MS;
/** How often replies left open are looked for. */
export const SWEEP_EVERY_MS = 10 * 60_000;
