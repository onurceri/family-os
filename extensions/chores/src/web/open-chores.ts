import type { Chore } from '../contract/index.js';

/** Whether any chore in the list is still to be done (a finished one-off chore is not). */
export const hasOpenChore = (chores: readonly Pick<Chore, 'nextDue'>[]): boolean =>
	chores.some((c) => c.nextDue !== null);
