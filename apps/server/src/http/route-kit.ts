import { type AccessControl, type Actor, FamosError, personPresent } from '@famos/sdk';
import type { z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from './env.ts';

/** A JSON body or answer in a route's OpenAPI description. */
export const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });

/** A required JSON request body in a route's OpenAPI description. */
export const body = <S extends z.ZodType>(schema: S) => ({
	body: { content: { 'application/json': { schema } }, required: true as const },
});

/** A route for signed-in callers of any kind (a display included); `requireCapability` narrows it. */
export function requireSignedIn(c: Context<AppEnv>): Actor {
	const actor = c.get('actor');
	if (!actor) throw new FamosError('unauthenticated', 'Sign in required');
	return actor;
}

/** A route for a person present: a member signed in themselves, not an app or a display. */
export function requirePerson(c: Context<AppEnv>) {
	const actor = c.get('actor');
	if (!actor || !personPresent(actor)) throw new FamosError('unauthenticated', 'Sign in required');
	return actor;
}

/** A signed-in caller who holds `capability`; `refusal` is what anyone else is told. */
export function requireCapability(
	c: Context<AppEnv>,
	access: AccessControl,
	capability: string,
	refusal: string,
): Actor {
	const actor = requireSignedIn(c);
	if (!access.can(actor, capability)) throw new FamosError('forbidden', refusal);
	return actor;
}
