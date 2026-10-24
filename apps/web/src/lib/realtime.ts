/**
 * One WebSocket to /api/v1/ws. The server pushes `{ type: 'event', name, payload }` after commits;
 * payloads carry IDs only, so listeners refetch what they show.
 */
import { forgetSharedReads } from '@famos/ui/famos';

type Listener = (name: string, payload: unknown) => void;

const listeners = new Set<Listener>();
/**
 * Called whenever the socket reconnects: events pushed while it was closed (a phone waking up)
 * were missed, so subscribers refetch what they keep. Not on the first connect: it opens together
 * with the first reads, which already see everything, so reading again would only read twice.
 */
const resyncers = new Set<() => void>();
let socket: WebSocket | undefined;
/** The pending reconnect, so a disconnect can cancel it. */
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let retry = 0;
let stopped = true;
/** Whether the socket has been open since `connectRealtime`. */
let connectedOnce = false;

function open() {
	reconnectTimer = undefined;
	// Never two sockets: one open or opening is the connection.
	if (stopped || socket) return;
	const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/ws`;
	const own = new WebSocket(url);
	socket = own;
	own.onopen = () => {
		retry = 0;
		if (connectedOnce) {
			// Changes may have been missed while the socket was closed: no read may join an old one.
			forgetSharedReads();
			for (const r of resyncers) r();
		}
		connectedOnce = true;
	};
	own.onmessage = (message) => {
		try {
			const data = JSON.parse(String(message.data)) as {
				type: string;
				name?: string;
				payload?: unknown;
			};
			if (data.type === 'event' && data.name) {
				// Reads that left before this change must not answer those who reload because of it.
				forgetSharedReads();
				for (const l of listeners) l(data.name, data.payload);
			}
		} catch {
			// ignore malformed messages
		}
	};
	own.onclose = () => {
		// A socket that was replaced or stopped is not the connection any more.
		if (socket !== own) return;
		socket = undefined;
		if (stopped) return;
		const delay = Math.min(30_000, 1000 * 2 ** retry++);
		reconnectTimer = setTimeout(open, delay);
	};
}

export function connectRealtime(): () => void {
	if (!stopped) return disconnectRealtime;
	stopped = false;
	connectedOnce = false;
	open();
	return disconnectRealtime;
}

export function disconnectRealtime(): void {
	stopped = true;
	clearTimeout(reconnectTimer);
	reconnectTimer = undefined;
	const closing = socket;
	socket = undefined;
	closing?.close();
}

/** Subscribes to events whose name starts with `prefix`. Returns an unsubscribe function. */
export function onEvent(prefix: string, handler: Listener): () => void {
	const listener: Listener = (name, payload) => {
		if (name.startsWith(prefix)) handler(name, payload);
	};
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Runs `handler` after every reconnect, to catch up on events missed meanwhile. */
export function onReconnect(handler: () => void): () => void {
	resyncers.add(handler);
	return () => resyncers.delete(handler);
}
