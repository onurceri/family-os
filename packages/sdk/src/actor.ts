import { z } from 'zod';
import type { Id } from './ids.ts';

export type MemberId = Id<'member'>;

/** A role id: one of the built-in roles (`admin`, `member`, `supervised`, `guest`) or `role_…`. */
export type RoleId = string;

/**
 * Who is performing an operation. Core and extensions only ever see an Actor; how it was
 * authenticated (password, PIN, kiosk device) is the identity adapter's concern.
 */
/** How an AI actor works; see `Actor`. */
export const AI_MODES = ['share', 'conversation', 'agent'] as const;
export type AiMode = (typeof AI_MODES)[number];

/** What an outside connection's token allows: reading only, or also suggesting changes. */
export const AI_SCOPES = ['read', 'read_write'] as const;
export type AiScope = (typeof AI_SCOPES)[number];

export type Actor =
	/**
	 * A person. `pin`: they signed in with a PIN on a family device. A PIN is short, so such a
	 * sign-in never holds a critical capability (managing people, devices, settings), whatever the
	 * role: a guessed PIN never yields administration.
	 */
	| { kind: 'member'; memberId: MemberId; roleId: RoleId; pin?: boolean }
	/**
	 * The AI. `mode` says how it works, and grants what goes with that and nothing else:
	 * - `share`: it reads what a member shared (untrusted content); what it proposes is the
	 *   sharer's to take back;
	 * - `conversation`: it answers a member in the app's own conversation, so it may use what is
	 *   meant for that person's own requests (`conversationOnly` actions, their personal notes);
	 * - `agent`: an agent of the family's own working for a member from outside (an MCP client).
	 * `source` names the extension or door it works for (`inbox`, `mcp`); nothing is decided by it.
	 * With `onBehalfOf` it acts for one member: it holds only capabilities that member holds as
	 * well (`roleId` is the member's role when the turn began), on top of the AI's own limits (view
	 * level, areas that are not off). Without it, it works for nobody in particular. `local`: the
	 * model that reads the results runs on the family's own network (absent means it does not),
	 * which decides whether data of local-only areas may reach it. `sourceId`: the conversation it
	 * works in (a thread, an app key of an MCP client), so it can tell its own suggestions from the
	 * person's others. `scope`: the limit of the connection it works through (an MCP token); `read`
	 * refuses every action that changes something, whatever the door offered.
	 */
	| {
			kind: 'ai';
			mode: AiMode;
			source: string;
			sourceId?: string;
			onBehalfOf?: MemberId;
			roleId?: RoleId;
			local?: boolean;
			scope?: AiScope;
	  }
	| { kind: 'system'; source: string }
	/**
	 * A paired family display: view-only, with the capabilities granted at pairing.
	 * It never writes, never signs in and sees member names only with `showNames`.
	 */
	| { kind: 'display'; deviceId: string; capabilities: readonly string[]; showNames: boolean };

export const ActorSchema: z.ZodType<Actor> = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('member'),
		memberId: z.custom<MemberId>(),
		roleId: z.string(),
		pin: z.boolean().optional(),
	}),
	z.object({
		kind: z.literal('ai'),
		mode: z.enum(AI_MODES),
		source: z.string(),
		sourceId: z.string().optional(),
		onBehalfOf: z.custom<MemberId>().optional(),
		roleId: z.string().optional(),
		local: z.boolean().optional(),
		scope: z.enum(AI_SCOPES).optional(),
	}),
	z.object({ kind: z.literal('system'), source: z.string() }),
	z.object({
		kind: z.literal('display'),
		deviceId: z.string(),
		capabilities: z.array(z.string()).readonly(),
		showNames: z.boolean(),
	}),
]);

export const systemActor = (source: string): Actor => ({ kind: 'system', source });

/**
 * The end of a switch over every `Actor` kind: `actor` is `never` while all are handled, so a kind
 * added later does not compile until each switch names it; one nobody knows at run time gets the
 * closed answer.
 */
function closed<T>(_actor: never, answer: T): T {
	return answer;
}

/**
 * The member an action is done by or for: a member's own id, or the member the AI works for.
 * Null for an AI working for nobody, a display and the system.
 */
export function memberBehind(actor: Actor): MemberId | null {
	switch (actor.kind) {
		case 'member':
			return actor.memberId;
		case 'ai':
			return actor.onBehalfOf ?? null;
		case 'display':
		case 'system':
			return null;
		default:
			return closed(actor, null);
	}
}

/**
 * The member acting for themselves: the id to compare with an assignee, an owner or an author.
 * Null for everyone else (the AI acts for a member, it is not that member), so a restriction
 * written as "self is not X" never lets a caller without a self through.
 */
export function selfOf(actor: Actor): MemberId | null {
	return actor.kind === 'member' ? actor.memberId : null;
}

/**
 * A human is acting directly, not through the AI, a display or background work. The one
 * predicate for acts that only a person present may do (deciding drafts, credentials, devices,
 * sessions, roles, members and extensions).
 */
export function personPresent(actor: Actor): actor is Extract<Actor, { kind: 'member' }> {
	return actor.kind === 'member';
}

/** A stable string naming who acted, for audit, attribution and idempotency keys. */
export function principalOf(actor: Actor): string {
	switch (actor.kind) {
		case 'member':
			return `member:${actor.memberId}`;
		case 'ai':
			return actor.sourceId === undefined
				? `ai:${actor.source}`
				: `ai:${actor.source}:${actor.sourceId}`;
		case 'display':
			return `display:${actor.deviceId}`;
		case 'system':
			return `system:${actor.source}`;
		default:
			return closed(actor, 'unknown');
	}
}
