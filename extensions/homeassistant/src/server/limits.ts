/** How long and how much the extension asks of Home Assistant in one call. */

/** A call that acts (a switch, a text, a connection check). */
export const CALL_TIMEOUT_MS = 10_000;
export const CALL_MAX_BYTES = 64 * 1024;

/** A person is waiting while an address is tried, so it gets less time than a background check. */
export const TEST_TIMEOUT_MS = 8_000;

/** One entity's state. */
export const ENTITY_TIMEOUT_MS = 5_000;
export const ENTITY_MAX_BYTES = 64 * 1024;

/** Every entity or every service of a home is in the answer, so a big home sends a lot. */
export const LIST_TIMEOUT_MS = 10_000;
export const LIST_MAX_BYTES = 4 * 1024 * 1024;
