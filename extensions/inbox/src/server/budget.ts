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
