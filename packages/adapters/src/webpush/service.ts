import type {
	Clock,
	DbExecutor,
	IdGenerator,
	Logger,
	NotificationChannel,
	NotificationMessage,
} from '@famos/sdk';
import { FamosError } from '@famos/sdk';
import type { SecretBox } from '../secrets/index.ts';
import { encryptPayload, generateVapidKeys, type VapidKeys, vapidAuthorization } from './crypto.ts';
import type { PushDevice, SubscribeInput } from './schemas.ts';
import { webPushTables } from './tables.ts';

/** Push services whose endpoints we accept; the endpoint comes from the browser (SSRF guard). */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
	'fcm.googleapis.com',
	'*.push.apple.com',
	'updates.push.services.mozilla.com',
	'push.services.mozilla.com',
	'*.push.services.mozilla.com',
	'*.notify.windows.com',
];

const MAX_PAYLOAD_BYTES = 3_000;
const MAX_DEVICES_PER_MEMBER = 20;
const SEND_TIMEOUT_MS = 10_000;
const VAPID_LIFETIME_S = 12 * 60 * 60;

export interface WebPushDeps {
	db: DbExecutor;
	box: SecretBox;
	clock: Clock;
	ids: IdGenerator;
	logger: Logger;
	/** The instance's address; it is the VAPID `sub` contact (an https: URL is allowed). */
	baseURL: string;
	fetch?: typeof fetch;
	/** Accepted push service hosts (`*.example.com` matches subdomains). Tests inject a stand-in. */
	allowedHosts?: readonly string[];
	/** Accept `http:` endpoints. Tests only. */
	allowInsecure?: boolean;
}

export type WebPush = ReturnType<typeof createWebPush>;

const decodeKey = (value: string, bytes: number): Buffer | null => {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
	const buf = Buffer.from(value, 'base64url');
	return buf.length === bytes ? buf : null;
};

function fitPayload(message: NotificationMessage): Buffer {
	let { title, body } = message;
	const build = () =>
		Buffer.from(JSON.stringify({ title, body, url: message.url, tag: message.tag }));
	let json = build();
	while (json.length > MAX_PAYLOAD_BYTES && body && body.length > 0) {
		body = body.length > 20 ? `${body.slice(0, Math.floor(body.length / 2))}…` : null;
		json = build();
	}
	if (json.length > MAX_PAYLOAD_BYTES) {
		title = `${title.slice(0, 200)}…`;
		json = build();
	}
	return json;
}

/**
 * Web Push (RFC 8030) with our own VAPID and message encryption (no dependency). The VAPID key
 * pair is created on first use and never rotated: a new key would invalidate every subscription.
 * Subscriptions are credentials, managed outside actions.
 */
export function createWebPush(deps: WebPushDeps) {
	const db = () => webPushTables(deps.db);
	const http = deps.fetch ?? fetch;
	const hosts = deps.allowedHosts ?? PUSH_SERVICE_HOSTS;
	let keys: VapidKeys | undefined;

	async function vapidKeys(): Promise<VapidKeys> {
		if (keys) return keys;
		let row = await db().selectFrom('webpush_keys').selectAll().executeTakeFirst();
		if (!row) {
			const fresh = generateVapidKeys();
			// Two processes may race on first use: the first insert wins, both then read it back.
			await db()
				.insertInto('webpush_keys')
				.values({
					id: 1,
					public_key: fresh.publicKey,
					private_key: deps.box.seal(fresh.privateKey),
					created_at: deps.clock.now(),
				})
				.onConflict((oc) => oc.doNothing())
				.execute();
			row = await db().selectFrom('webpush_keys').selectAll().executeTakeFirstOrThrow();
		}
		const privateKey = deps.box.open(row.private_key);
		if (privateKey === null)
			throw new FamosError(
				'unavailable',
				'The Web Push key cannot be read: FAMOS_SECRET differs from the one it was sealed with',
			);
		keys = { publicKey: row.public_key, privateKey };
		return keys;
	}

	const hostAllowed = (hostname: string) =>
		hosts.some((h) =>
			h.startsWith('*.')
				? hostname.endsWith(h.slice(1)) && hostname.length > h.length - 1
				: hostname === h,
		);

	function checkEndpoint(endpoint: string): URL {
		let url: URL;
		try {
			url = new URL(endpoint);
		} catch {
			throw new FamosError('bad_request', 'Invalid push endpoint');
		}
		const protocolOk =
			url.protocol === 'https:' || (deps.allowInsecure && url.protocol === 'http:');
		if (!protocolOk || url.username || url.password || !hostAllowed(url.hostname))
			throw new FamosError('bad_request', 'This push service is not supported');
		return url;
	}

	async function subscriptionsOf(memberId: string) {
		return db()
			.selectFrom('webpush_subscriptions')
			.selectAll()
			.where('member_id', '=', memberId)
			.orderBy('created_at')
			.execute();
	}

	type Outcome = 'ok' | 'gone' | 'skipped' | 'retry';

	async function post(
		sub: { id: string; endpoint: string; p256dh: string; auth: string },
		payload: Buffer,
		vapid: VapidKeys,
	): Promise<Outcome> {
		const url = new URL(sub.endpoint);
		const log = deps.logger.child({ host: url.host });
		const uaPublic = decodeKey(sub.p256dh, 65);
		const authSecret = decodeKey(sub.auth, 16);
		if (!uaPublic || !authSecret) return 'gone';
		const body = encryptPayload({ plaintext: payload, uaPublic, authSecret });
		let res: Response;
		try {
			res = await http(sub.endpoint, {
				method: 'POST',
				headers: {
					TTL: '86400',
					Urgency: 'normal',
					'Content-Encoding': 'aes128gcm',
					'Content-Type': 'application/octet-stream',
					Authorization: vapidAuthorization(vapid, {
						aud: url.origin,
						sub: deps.baseURL,
						exp: Math.floor(deps.clock.now() / 1000) + VAPID_LIFETIME_S,
					}),
				},
				body: new Uint8Array(body),
				redirect: 'error',
				signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
			});
		} catch (error) {
			log.warn({ err: (error as Error).name }, 'push request failed');
			return 'retry';
		}
		// The body is not needed; release the connection.
		void res.body?.cancel().catch(() => {});
		if (res.status === 200 || res.status === 201 || res.status === 202) {
			await db()
				.updateTable('webpush_subscriptions')
				.set({ last_success_at: deps.clock.now() })
				.where('id', '=', sub.id)
				.execute();
			return 'ok';
		}
		if (res.status === 404 || res.status === 410) {
			await db().deleteFrom('webpush_subscriptions').where('id', '=', sub.id).execute();
			log.info({ status: res.status }, 'push subscription expired and removed');
			return 'gone';
		}
		if (res.status === 413) {
			log.warn({ status: res.status }, 'push payload rejected as too large; skipped');
			return 'skipped';
		}
		log.warn({ status: res.status }, 'push service refused the message');
		return 'retry';
	}

	/** Sends to every device of the member and tallies what happened. */
	async function deliver(memberId: string, message: NotificationMessage) {
		const subs = await subscriptionsOf(memberId);
		const tally = { total: subs.length, ok: 0, gone: 0, skipped: 0, retry: 0 };
		if (subs.length === 0) return tally;
		const vapid = await vapidKeys();
		const payload = fitPayload(message);
		const outcomes = await Promise.all(subs.map((s) => post(s, payload, vapid)));
		for (const o of outcomes) tally[o === 'ok' ? 'ok' : o]++;
		return tally;
	}

	const channel: NotificationChannel = {
		id: 'webpush',
		label: 'app:channel_webpush',
		async isAvailableFor(memberId) {
			return (await subscriptionsOf(memberId)).length > 0;
		},
		async send(memberId, message) {
			const t = await deliver(memberId, message);
			if (t.ok === 0 && t.retry > 0)
				throw new Error(`Web Push delivery failed for ${t.retry} of ${t.total} device(s)`);
			// No device left (or all expired): nothing to retry.
			if (t.ok === 0 && t.skipped === 0) return 'gone';
			return 'sent';
		},
	};

	return {
		channel,
		/** The `applicationServerKey` the browser subscribes with. */
		async publicKey(): Promise<string> {
			return (await vapidKeys()).publicKey;
		},
		async subscribe(memberId: string, sub: SubscribeInput, label?: string): Promise<void> {
			checkEndpoint(sub.endpoint);
			if (!decodeKey(sub.keys.p256dh, 65) || !decodeKey(sub.keys.auth, 16))
				throw new FamosError('bad_request', 'Invalid push keys');
			const name = (label ?? sub.label ?? '').trim().slice(0, 60);
			const existing = await db()
				.selectFrom('webpush_subscriptions')
				.select(['id', 'label'])
				.where('endpoint', '=', sub.endpoint)
				.executeTakeFirst();
			if (existing) {
				// The same browser signed in as someone else: the subscription moves with it.
				await db()
					.updateTable('webpush_subscriptions')
					.set({
						member_id: memberId,
						p256dh: sub.keys.p256dh,
						auth: sub.keys.auth,
						label: name || existing.label,
					})
					.where('id', '=', existing.id)
					.execute();
				return;
			}
			if ((await subscriptionsOf(memberId)).length >= MAX_DEVICES_PER_MEMBER)
				throw new FamosError('limit_reached', 'Too many devices; remove one first');
			await db()
				.insertInto('webpush_subscriptions')
				.values({
					id: deps.ids.next('push_sub'),
					member_id: memberId,
					endpoint: sub.endpoint,
					p256dh: sub.keys.p256dh,
					auth: sub.keys.auth,
					label: name || 'Unknown device',
					created_at: deps.clock.now(),
					last_success_at: null,
				})
				.execute();
		},
		async unsubscribe(memberId: string, endpoint: string): Promise<void> {
			await db()
				.deleteFrom('webpush_subscriptions')
				.where('member_id', '=', memberId)
				.where('endpoint', '=', endpoint)
				.execute();
		},
		/** The member's devices, without endpoints or keys. */
		async list(memberId: string): Promise<PushDevice[]> {
			return (await subscriptionsOf(memberId)).map((s) => ({
				label: s.label,
				createdAt: s.created_at,
				lastSuccessAt: s.last_success_at,
			}));
		},
		/** An explicit test from the person: direct, not through the queue. Returns devices reached. */
		async sendTest(
			memberId: string,
			message: { title: string; body?: string | null } = { title: 'Test notification' },
		): Promise<number> {
			const t = await deliver(memberId, {
				title: message.title,
				body: message.body ?? null,
				url: '/notifications',
				link: null,
				tag: 'test',
			});
			return t.ok;
		},
	};
}
