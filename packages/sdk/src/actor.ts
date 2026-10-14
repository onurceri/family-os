import { z } from 'zod';
import type { Id } from './ids.ts';

export type MemberId = Id<'member'>;

/** A role id: one of the built-in roles (`admin`, `member`, `supervised`, `guest`) or `role_…`. */
export type RoleId = string;

/**
 * Who is performing an operation. Core and extensions only ever see an Actor; how it was
 * authenticated (password, PIN, kiosk device) is the identity adapter's concern.
 */
export type Actor =
	| { kind: 'member'; memberId: MemberId; roleId: RoleId }
	/**
	 * The AI. With `onBehalfOf` it acts for one member (the assistant answering them): it holds
	 * only capabilities that member holds as well (`roleId` is the member's role when the turn
	 * began), on top of the AI's own limits (view level, areas that are not off). Without it, it
	 * works for nobody in particular (the Inbox). `local`: the model that reads the results runs
	 * on the family's own network (absent means it does not), which decides whether data of
	 * local-only areas may reach it. `sourceId`: the conversation it works in (an assistant thread,
	 * an app key of an MCP client), so it can tell its own suggestions from the person's others.
	 */
	| {
			kind: 'ai';
			source: string;
			sourceId?: string;
			onBehalfOf?: MemberId;
			roleId?: RoleId;
			local?: boolean;
	  }
	| { kind: 'system'; source: string }
	/**
	 * A paired family display: view-only, with the capabilities granted at pairing.
	 * It never writes, never signs in and sees member names only with `showNames`.
	 */
	| { kind: 'display'; deviceId: string; capabilities: readonly string[]; showNames: boolean };

export const ActorSchema: z.ZodType<Actor> = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('member'), memberId: z.custom<MemberId>(), roleId: z.string() }),
	z.object({
		kind: z.literal('ai'),
		source: z.string(),
		sourceId: z.string().optional(),
		onBehalfOf: z.custom<MemberId>().optional(),
		roleId: z.string().optional(),
		local: z.boolean().optional(),
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
