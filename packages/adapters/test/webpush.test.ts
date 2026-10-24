import { createECDH, createPublicKey, randomBytes, verify } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDatabase, runMigrations } from '@famos/db';
import { FamosError } from '@famos/sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger, uuidv7Ids } from '../src/runtime/index.ts';
import { createSecretBox } from '../src/secrets/index.ts';
import {
	createWebPush,
	decryptPayload,
	encryptPayload,
	generateVapidKeys,
	vapidAuthorization,
	type WebPush,
	webPushMigrations,
} from '../src/webpush/index.ts';

const b = (s: string) => Buffer.from(s, 'base64url');

describe('RFC 8291 encryption', () => {
	it('matches the Appendix A test vector', () => {
		const body = encryptPayload({
			plaintext: b('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
			uaPublic: b(
				'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
			),
			authSecret: b('BTBZMqHH6r4Tts7J_aSIgg'),
			asPrivate: b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
			salt: b('DGv6ra1nlYgDCS1FRnbzlw'),
		});
		const header = b(
			'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
		);
		const ciphertext = b(
			'8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
		);
		expect(header.length).toBe(86);
		expect(body.equals(Buffer.concat([header, ciphertext]))).toBe(true);
	});

	it('round-trips with a fresh key', () => {
		const ua = createECDH('prime256v1');
		ua.generateKeys();
		const auth = randomBytes(16);
		const body = encryptPayload({
			plaintext: Buffer.from('héllo'),
			uaPublic: ua.getPublicKey(),
			authSecret: auth,
		});
		expect(decryptPayload(body, ua.getPrivateKey(), ua.getPublicKey(), auth).toString()).toBe(
			'héllo',
		);
	});
});

describe('VAPID', () => {
	it('signs a JWT that verifies with the public key', () => {
		const keys = generateVapidKeys();
		const header = vapidAuthorization(keys, {
			aud: 'https://fcm.googleapis.com',
			sub: 'https://family.example',
			exp: 2_000_000_000,
		});
		const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
		expect(match).not.toBeNull();
		const [, h, c, s, k] = match as RegExpExecArray;
		expect(k).toBe(keys.publicKey);
		expect(JSON.parse(b(h as string).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
		expect(JSON.parse(b(c as string).toString())).toEqual({
			aud: 'https://fcm.googleapis.com',
			sub: 'https://family.example',
			exp: 2_000_000_000,
		});
		const point = b(keys.publicKey);
		const publicKey = createPublicKey({
			format: 'jwk',
			key: {
				kty: 'EC',
				crv: 'P-256',
				x: point.subarray(1, 33).toString('base64url'),
				y: point.subarray(33, 65).toString('base64url'),
			},
		});
		expect(b(s as string).length).toBe(64);
		expect(
			verify(
				'sha256',
				Buffer.from(`${h}.${c}`),
				{ key: publicKey, dsaEncoding: 'ieee-p1363' },
				b(s as string),
			),
		).toBe(true);
	});
});

// A stand-in push service: the path picks the answer.
type Seen = { path: string; headers: http.IncomingHttpHeaders; body: Buffer };
const seen: Seen[] = [];
const server = http.createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on('data', (c: Buffer) => chunks.push(c));
	req.on('end', () => {
		seen.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
		const status = Number(/status-(\d+)/.exec(req.url ?? '')?.[1] ?? 201);
		res.writeHead(status).end();
	});
});
let origin = '';
beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let push: WebPush;
let db: ReturnType<typeof openDatabase>['db'];
const browser = createECDH('prime256v1');
browser.generateKeys();
const auth = randomBytes(16);
const keys = {
	p256dh: browser.getPublicKey().toString('base64url'),
	auth: auth.toString('base64url'),
};
const message = {
	title: 'Dinner at 6',
	body: 'Grandma is coming',
	url: '/calendar',
	link: null,
	tag: 'notif_1',
};

const make = (overrides: Partial<Parameters<typeof createWebPush>[0]> = {}) =>
	createWebPush({
		db,
		box: createSecretBox('s'.repeat(32), 'webpush'),
		clock: { now: () => Date.UTC(2026, 9, 7, 9) },
		ids: uuidv7Ids,
		logger: silentLogger,
		baseURL: 'https://family.example',
		allowedHosts: ['127.0.0.1'],
		allowInsecure: true,
		...overrides,
	});

beforeEach(async () => {
	seen.length = 0;
	({ db } = openDatabase({ path: ':memory:' }));
	await runMigrations(db, [{ scope: 'webpush', migrations: webPushMigrations }]);
	push = make();
});

const sub = (path: string) => ({ endpoint: `${origin}/${path}`, keys });

describe('Web Push channel', () => {
	it('keeps one key pair across restarts and seals the private key', async () => {
		const first = await push.publicKey();
		expect(await make().publicKey()).toBe(first);
		const row = await db
			.withTables<{ webpush_keys: { private_key: string } }>()
			.selectFrom('webpush_keys')
			.selectAll()
			.executeTakeFirstOrThrow();
		expect(row.private_key.startsWith('v1.')).toBe(true);
		// Another FAMOS_SECRET cannot open the private key: a clear error, never a new key pair.
		await expect(
			make({ box: createSecretBox('x'.repeat(32), 'webpush') }).publicKey(),
		).rejects.toMatchObject({
			code: 'unavailable',
		});
	});

	it('sends an encrypted message with VAPID headers and marks success', async () => {
		await push.subscribe('mem_1', sub('ok'), '  iPhone · Safari ');
		expect(await push.channel.isAvailableFor('mem_1')).toBe(true);
		expect(await push.channel.isAvailableFor('mem_2')).toBe(false);
		expect(await push.channel.send('mem_1', message)).toBe('sent');

		const req = seen[0] as Seen;
		expect(req.headers.ttl).toBe('86400');
		expect(req.headers['content-encoding']).toBe('aes128gcm');
		expect(req.headers.urgency).toBe('normal');
		expect(req.headers.authorization).toContain(`k=${await push.publicKey()}`);
		const plain = decryptPayload(req.body, browser.getPrivateKey(), browser.getPublicKey(), auth);
		// The payload carries what the service worker shows; the absolute link is for other channels.
		expect(JSON.parse(plain.toString())).toEqual({ ...message, link: undefined });
		const [device] = await push.list('mem_1');
		expect(device).toMatchObject({
			label: 'iPhone · Safari',
			lastSuccessAt: Date.UTC(2026, 9, 7, 9),
		});
		expect(JSON.stringify(await push.list('mem_1'))).not.toContain('127.0.0.1');
	});

	it('truncates long messages to stay small', async () => {
		await push.subscribe('mem_1', sub('ok'));
		await push.channel.send('mem_1', { ...message, body: 'x'.repeat(20_000) });
		const req = seen[0] as Seen;
		expect(req.body.length).toBeLessThan(4_000);
		const plain = decryptPayload(req.body, browser.getPrivateKey(), browser.getPublicKey(), auth);
		expect(JSON.parse(plain.toString()).title).toBe('Dinner at 6');
	});

	it('removes a subscription the push service reports gone', async () => {
		await push.subscribe('mem_1', sub('status-410'));
		expect(await push.channel.send('mem_1', message)).toBe('gone');
		expect(await push.list('mem_1')).toEqual([]);
		expect(await push.channel.send('mem_1', message)).toBe('gone');
	});

	it('sends if at least one device was reached, even when another expired', async () => {
		await push.subscribe('mem_1', sub('status-404'));
		await push.subscribe('mem_1', sub('ok'));
		expect(await push.channel.send('mem_1', message)).toBe('sent');
		expect(await push.list('mem_1')).toHaveLength(1);
	});

	it('throws on rate limits and server errors so the queue retries', async () => {
		await push.subscribe('mem_1', sub('status-429'));
		await expect(push.channel.send('mem_1', message)).rejects.toThrow();
		expect(await push.list('mem_1')).toHaveLength(1);
		await push.unsubscribe('mem_1', `${origin}/status-429`);
		await push.subscribe('mem_1', sub('status-503'));
		await expect(push.channel.send('mem_1', message)).rejects.toThrow();
	});

	it('skips a payload the service finds too large instead of retrying', async () => {
		await push.subscribe('mem_1', sub('status-413'));
		expect(await push.channel.send('mem_1', message)).toBe('sent');
	});

	it('moves an endpoint to the member who subscribes with it now', async () => {
		await push.subscribe('mem_1', sub('ok'), 'Tablet');
		await push.subscribe('mem_2', sub('ok'));
		expect(await push.list('mem_1')).toEqual([]);
		expect((await push.list('mem_2'))[0]?.label).toBe('Tablet');
	});

	it('counts devices reached by a test message', async () => {
		await push.subscribe('mem_1', sub('ok'));
		await push.subscribe('mem_1', sub('status-410'));
		expect(await push.sendTest('mem_1', { title: 'Test' })).toBe(1);
	});

	it('accepts only known push services over https', async () => {
		const strict = make({ allowedHosts: undefined, allowInsecure: false });
		const reject = async (endpoint: string) => {
			const error = await strict.subscribe('mem_1', { endpoint, keys }).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(FamosError);
			expect((error as FamosError).code).toBe('bad_request');
		};
		await reject('http://fcm.googleapis.com/fcm/send/abc');
		await reject('https://evil.example/fcm.googleapis.com');
		await reject('https://fcm.googleapis.com.evil.example/x');
		await reject('https://169.254.169.254/latest');
		await reject('https://push.apple.com.evil.example/x');
		await reject('https://user:pw@fcm.googleapis.com/x');
		await reject('not a url');
		await strict.subscribe('mem_1', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys });
		await strict.subscribe('mem_1', { endpoint: 'https://web.push.apple.com/abc', keys });
		await strict.subscribe('mem_1', { endpoint: 'https://wns2.notify.windows.com/x', keys });
		await strict.subscribe('mem_1', {
			endpoint: 'https://updates.push.services.mozilla.com/x',
			keys,
		});
		await expect(
			strict.subscribe('mem_1', {
				endpoint: 'https://fcm.googleapis.com/y',
				keys: { p256dh: 'abc', auth: 'def' },
			}),
		).rejects.toMatchObject({ code: 'bad_request' });
	});
});
