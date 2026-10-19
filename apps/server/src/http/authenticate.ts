import type { Identity } from '@famos/adapters/identity-betterauth';
import {
	type AuthenticatedToken,
	CORE_CAPABILITIES,
	type CoreTables,
	displayActor,
	type Kernel,
} from '@famos/core';
import { type Actor, FamosError, type MemberId } from '@famos/sdk';
import { deviceTokenFromHeaders } from './devices.ts';

/**
 * The ways in. Each door reads one kind of credential and lets in only the kinds of caller that
 * credential can stand for, so a credential meant for one door never works at another:
 * - `session`: the app's own API and its socket, by the session cookie (a member) or a paired
 *   display's device cookie; a bearer header is refused outright;
 * - `mcp`: the AI agents' endpoint, by a bearer token; cookies are never read.
 */
export type Door = 'session' | 'mcp';

/** The kinds of caller each door admits. */
export const DOOR_KINDS = {
	session: ['member', 'display'],
	mcp: ['ai'],
} as const satisfies Record<Door, readonly Actor['kind'][]>;

/** Whether a door admits this kind of caller. */
export const admits = (door: Door, kind: Actor['kind']): boolean =>
	(DOOR_KINDS[door] as readonly string[]).includes(kind);

type SessionDeps = { kernel: Kernel; identity: Pick<Identity, 'resolveMember'> };

/**
 * Who calls the app's own API: a signed-in member, or else a paired family display, or null. A
 * member session always wins, so an admin who signs in on a display's browser acts as themselves.
 * Throws `bad_request` for an `Authorization` header, which no route here reads: a future bearer
 * can never reach these routes by accident.
 */
export async function authenticate(
	deps: SessionDeps,
	headers: Headers,
	door: 'session',
): Promise<Actor | null> {
	if (headers.has('authorization'))
		throw new FamosError(
			'bad_request',
			'This API takes a signed-in session, not an Authorization header',
		);
	const member = await resolveMember(deps.kernel, deps.identity, headers);
	// The device is checked on every request, so revoking a display ends it at once.
	const actor =
		member ?? displayActor(await deps.kernel.devices.verify(deviceTokenFromHeaders(headers)));
	return actor && admits(door, actor.kind) ? actor : null;
}

/**
 * Resolves the session cookie to an active member Actor, or null. A PIN session counts only while
 * its device is still trusted and the member's role still allows PIN sign-in, so revoking a device
 * or changing a role takes effect on the next request even if ending the sessions failed. It is
 * marked `pin`, so it never holds a critical capability.
 */
async function resolveMember(
	kernel: Kernel,
	identity: Pick<Identity, 'resolveMember'>,
	headers: Headers,
): Promise<Actor | null> {
	const session = await identity.resolveMember(headers);
	if (!session) return null;
	const member = await kernel.ctx.db
		.withTables<CoreTables>()
		.selectFrom('core_members')
		.select(['id', 'role_id'])
		.where('id', '=', session.memberId)
		.where('archived_at', 'is', null)
		.executeTakeFirst();
	if (!member) return null;
	const actor: Actor = { kind: 'member', memberId: member.id as MemberId, roleId: member.role_id };
	if (!session.deviceId) return actor;
	if (!(await kernel.devices.isActive(session.deviceId))) return null;
	if (!kernel.access.effective(member.role_id).has(CORE_CAPABILITIES.signInPin.id)) return null;
	return { ...actor, pin: true };
}

/** What a bearer token is let in as, or why it is not. */
export type BearerResult =
	| { outcome: 'ok'; actor: Actor; principal: AuthenticatedToken }
	| { outcome: 'missing' }
	| { outcome: 'unknown' }
	| { outcome: 'forbidden' };

/**
 * The AI an API token stands for: it works for the token's member, with the token's scope on it
 * so the action runner itself refuses a change from a read-only token.
 */
export function mcpActor(principal: AuthenticatedToken): Actor {
	return {
		kind: 'ai',
		mode: 'agent',
		source: 'mcp',
		// What this app key suggested is its own; the person's other suggestions are not.
		sourceId: principal.token.id,
		onBehalfOf: principal.member.id as MemberId,
		roleId: principal.member.roleId,
		scope: principal.token.scope,
	};
}

/**
 * Who calls the MCP endpoint: the `Authorization: Bearer` header only, never a cookie. The
 * token's person must still hold the capability to use tokens.
 */
export async function authenticateBearer(kernel: Kernel, headers: Headers): Promise<BearerResult> {
	const header = /^Bearer\s+(\S+)$/i.exec(headers.get('authorization') ?? '');
	if (!header) return { outcome: 'missing' };
	const principal = await kernel.apiTokens.authenticate(header[1]);
	if (!principal) return { outcome: 'unknown' };
	const holder: Actor = {
		kind: 'member',
		memberId: principal.member.id as MemberId,
		roleId: principal.member.roleId,
	};
	if (!kernel.access.can(holder, CORE_CAPABILITIES.mcpUse.id)) return { outcome: 'forbidden' };
	const actor = mcpActor(principal);
	if (!admits('mcp', actor.kind)) return { outcome: 'forbidden' };
	return { outcome: 'ok', actor, principal };
}
