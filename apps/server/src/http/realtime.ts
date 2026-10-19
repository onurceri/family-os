import {
	type Access,
	audienceOf,
	deviceChanged,
	type InProcessEventBus,
	inAudience,
	memberChanged,
	sessionEnded,
} from '@famos/core';
import { type Actor, type EventDefinition, type Logger, personPresent, selfOf } from '@famos/sdk';
import type { MiddlewareHandler } from 'hono';
import type { WSContext } from 'hono/ws';

/**
 * Pushes `{ type: 'event', name, payload }` to the connected clients that may hear of it, after
 * commit. Payloads carry IDs only; clients refetch what they need.
 *
 * Every socket belongs to the actor that opened it, and an event goes to a socket only when that
 * actor is in the event's audience (see `defineEvent`): a member who cannot see an area, or a
 * display that was not granted it, hears nothing of it, not even that something changed.
 * Sockets are checked when they open, so whatever changes who the actor is closes them (below),
 * and the client reconnects and is checked again.
 */
export function createRealtimeHub(
	bus: InProcessEventBus,
	logger: Logger,
	access: Pick<Access, 'can' | 'capability'>,
	events: ReadonlyMap<string, Pick<EventDefinition, 'audience'>>,
) {
	const clients = new Map<WSContext, Actor>();

	const send = (ws: WSContext, message: string) => {
		try {
			ws.send(message);
		} catch (error) {
			logger.debug({ err: error }, 'dropping websocket client');
			clients.delete(ws);
		}
	};
	const close = (match: (actor: Actor) => boolean, reason: string) => {
		for (const [ws, actor] of clients) {
			if (!match(actor)) continue;
			clients.delete(ws);
			try {
				ws.close(4401, reason);
			} catch (error) {
				logger.debug({ err: error }, 'closing websocket failed');
			}
		}
	};

	// Private events (assistant answers): the addressed member's own sockets, and only while that
	// member is still in the event's audience.
	bus.onMember((memberId, name, payload) => {
		const message = JSON.stringify({ type: 'event', name, payload });
		const targets = audienceOf(events.get(name), name, payload);
		for (const [ws, actor] of clients) {
			if (selfOf(actor) !== memberId) continue;
			if (inAudience(access, actor, targets)) send(ws, message);
		}
	});
	bus.onAny((name, payload) => {
		const message = JSON.stringify({ type: 'event', name, payload });
		const targets = audienceOf(events.get(name), name, payload);
		for (const [ws, actor] of clients) {
			if (inAudience(access, actor, targets)) send(ws, message);
		}
		// A display was revoked or changed: end its socket now. The display reconnects and is
		// checked again, so a revoked one is refused and a changed one gets its new rights. A PIN
		// session lives on a family device, so those end with it too.
		if (name === deviceChanged.name) {
			const deviceId = (payload as { deviceId?: string }).deviceId;
			if (deviceId)
				close(
					(actor) =>
						(actor.kind === 'display' && actor.deviceId === deviceId) ||
						(personPresent(actor) && actor.pin === true),
					'device_changed',
				);
		}
		// A member was archived, got another role or other details, or signed out (here, or
		// everywhere, or by a new password): their sockets were opened as someone else.
		if (name === memberChanged.name || name === sessionEnded.name) {
			const memberId = (payload as { memberId?: string }).memberId;
			if (memberId) close((actor) => selfOf(actor) === memberId, 'member_changed');
		}
	});
	return {
		/** `actor`: who opened the socket, a signed-in member or a paired display. */
		events: (actor: Actor) => ({
			onOpen: (_event: unknown, ws: WSContext) => {
				clients.set(ws, actor);
				ws.send(JSON.stringify({ type: 'hello' }));
			},
			onClose: (_event: unknown, ws: WSContext) => {
				clients.delete(ws);
			},
		}),
		size: () => clients.size,
	};
}

/**
 * Guards the WebSocket upgrade. A page of another origin (another port of this host, say) carries
 * the member's cookie too, so only this app's own pages (the base URL and the trusted origins)
 * may open the socket; a client that is no browser sends no Origin and has no ambient cookie to
 * abuse. Then the same rules as the API: no signed-in member or paired display, no socket.
 * `actor` is the one the API's middleware resolved for the request.
 */
export function realtimeGuard(
	trustedOrigins: readonly string[],
	actorOf: (c: Parameters<MiddlewareHandler>[0]) => Actor | null | undefined,
): MiddlewareHandler {
	return async (c, next) => {
		const origin = c.req.header('origin');
		if (origin !== undefined && !trustedOrigins.includes(origin))
			return c.json({ error: { code: 'forbidden', message: 'Origin not allowed' } }, 403);
		if (!actorOf(c))
			return c.json({ error: { code: 'unauthenticated', message: 'Sign in required' } }, 401);
		return next();
	};
}
