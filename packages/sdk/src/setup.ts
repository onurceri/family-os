import { z } from 'zod';

/**
 * The first account's own fields at first-run setup. The server's setup route takes them and the
 * setup page checks them with the same schema before it sends anything, so both refuse the same
 * values for the same reasons.
 */
export const SetupAccountSchema = z.object({
	displayName: z.string().trim().min(1).max(60),
	email: z.email(),
	password: z.string().min(10).max(200),
	/** The code from the server log or `data/setup-code`, so a fresh instance cannot be claimed. */
	setupCode: z.string().max(100).optional(),
});
