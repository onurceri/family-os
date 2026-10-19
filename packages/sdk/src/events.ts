import type { z } from 'zod';

/**
 * In-process events, emitted only after the surrounding transaction commits. Payloads carry IDs,
 * not data. Use events for UI invalidation and non-critical reactions; anything that must
 * survive a crash goes through the job queue instead.
 */
/** Anyone signed in or paired as a display. */
export const EVERYONE = { everyone: true } as const;
/** Any signed-in person; a display is not one. */
export const ANY_MEMBER = { anyMember: true } as const;

/**
 * One way to be in an event's audience: a capability the receiver holds, one member by id (a
 * row that belongs to a person), or everyone / any signed-in member for what every screen shows.
 */
export type AudienceTarget =
	| string
	| { readonly member: string }
	| typeof EVERYONE
	| typeof ANY_MEMBER;

/** Who may receive an event: any of these targets. An empty list is nobody (internal events). */
export type AudienceRule<Payload = unknown> =
	| AudienceTarget
	| readonly AudienceTarget[]
	| ((payload: Payload) => AudienceTarget | readonly AudienceTarget[]);

export interface EventDefinition<
	Name extends string = string,
	Schema extends z.ZodType = z.ZodType,
> {
	readonly name: Name;
	readonly payload: Schema;
	/**
	 * Who may be told. Left out, the event goes only to those who hold the `view` capability of
	 * the extension that owns it (the part of the name before the first dot): `calendar.view` for
	 * `calendar.event.changed`. A display receives it only if that capability was granted to it.
	 * Give a payload function when rows differ in who may see them.
	 */
	readonly audience?: AudienceRule<z.infer<Schema>>;
}

export function defineEvent<const Name extends string, Schema extends z.ZodType>(
	name: Name,
	payload: Schema,
	options: { audience?: AudienceRule<z.infer<Schema>> } = {},
): EventDefinition<Name, Schema> {
	return options.audience === undefined
		? { name, payload }
		: { name, payload, audience: options.audience };
}

export type EventPayload<E extends EventDefinition> = z.infer<E['payload']>;

export type Unsubscribe = () => void;

export interface EventBus {
	on<E extends EventDefinition>(
		event: E,
		handler: (payload: EventPayload<E>) => void | Promise<void>,
	): Unsubscribe;
	/** Every event, for transports such as the WebSocket broadcaster. */
	onAny(handler: (name: string, payload: unknown) => void | Promise<void>): Unsubscribe;
	/**
	 * Publishes outside a unit of work, for jobs whose writes are already committed. Inside an
	 * action use `uow.emit`, which publishes only if the transaction commits.
	 */
	emit<E extends EventDefinition>(event: E, payload: EventPayload<E>): Promise<void>;
	/**
	 * Publishes to one member only: the realtime transport delivers it to that member's own
	 * connections, never to other members or displays, and nothing is stored. For content that is
	 * private to a person (assistant answers); ordinary handlers and `onAny` never see it.
	 */
	emitTo<E extends EventDefinition>(
		memberId: string,
		event: E,
		payload: EventPayload<E>,
	): Promise<void>;
}

/** Collects events during a unit of work; they are published only if it commits. */
export interface EventEmitter {
	emit<E extends EventDefinition>(event: E, payload: EventPayload<E>): void;
}
