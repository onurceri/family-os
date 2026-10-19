import { type Actor, type MemberId, personPresent } from './actor.ts';
import type { AccessControl } from './capabilities.ts';
import type { FamilyReader } from './context.ts';
import { FamosError } from './errors.ts';

/** A person who signed in with a password: not a PIN, not the AI, a display or the system. */
export type FullSignInActor = Extract<Actor, { kind: 'member' }> & { via?: undefined };

/** Whether the actor is a member who signed in with a password rather than a PIN. */
export const isFullSignIn = (actor: Actor): actor is FullSignInActor =>
	personPresent(actor) && actor.pin !== true;

/**
 * The rule for every credential that works away from the device it was made on (an API token, a
 * calendar address, a link to a chat app): only a person who signed in with a password may create
 * one. A PIN is short and works on shared family devices, so it must never mint something that
 * outlives the session. Call it first in the action or route that creates such a credential.
 */
export function assertFullSignIn(actor: Actor): asserts actor is FullSignInActor {
	if (!personPresent(actor)) throw new FamosError('unauthenticated', 'Sign in required');
	if (actor.pin === true)
		throw new FamosError('forbidden', 'Sign in with your password to create keys', {
			reason: 'full_sign_in',
		});
}

/**
 * A credential acts for the member who made it and is only as strong as that member is now. On
 * every use, resolve its owner with this: the member as an actor when they are still active and
 * hold every given capability today, otherwise null (answer as if the credential did not exist).
 * The actor is never a PIN sign-in, since a credential is not a device session.
 */
export async function credentialOwner(
	deps: { family: Pick<FamilyReader, 'members'>; access: Pick<AccessControl, 'can'> },
	memberId: string,
	capabilities: string | readonly string[],
): Promise<FullSignInActor | null> {
	const member = (await deps.family.members()).find((m) => m.id === memberId);
	if (!member) return null;
	const actor: FullSignInActor = {
		kind: 'member',
		memberId: member.id as MemberId,
		roleId: member.roleId,
	};
	for (const capability of [capabilities].flat())
		if (!deps.access.can(actor, capability)) return null;
	return actor;
}
