import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import type { MemberId } from '@famos/sdk';
import {
	defineAction,
	defineCapability,
	defineExtension,
	type ExtensionDefinition,
} from '@famos/sdk';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../src/config.ts';
import { extensions } from '../src/extensions.ts';
import { createHttpApp } from '../src/http/app.ts';
import { MCP_RATE_PER_MINUTE } from '../src/mcp/http.ts';
import { APP_VERSION, migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { fastPasswordHasher } from './fast-password.ts';

const BASE = 'http://localhost:3000';
let runtime: Runtime;
let app: ReturnType<typeof createHttpApp>;

// An external action (a person's, outside the house): it never becomes a tool, with or without hints.
const sendMail = defineCapability({ id: 'outbox.send', label: 'outbox:cap_send', level: 'edit' });
const mailOut = defineAction({
	id: 'outbox.sendMail',
	title: 'Send mail',
	input: z.object({ to: z.string() }),
	output: z.object({ sent: z.boolean() }),
	external: true,
	requires: sendMail.id,
	approval: 'never',
	async run() {
		return { sent: true };
	},
});
const outbox = defineExtension({ id: 'outbox', actions: [mailOut], capabilities: [sendMail] });

async function boot(extra: readonly ExtensionDefinition[] = []) {
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-mcp-'));
	const config = await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: BASE });
	runtime = openRuntime(config, {
		logger: silentLogger,
		quiet: true,
		passwordHasher: fastPasswordHasher,
		extensions: [...extensions, ...extra],
	});
	await migrate(runtime);
	await runtime.kernel.start();
	app = createHttpApp({
		kernel: runtime.kernel,
		ai: runtime.ai,
		webPush: runtime.webPush,
		telegram: runtime.telegram,
		email: runtime.email,
		backups: runtime.backups,
		backupsDir: runtime.config.backupsDir,
		backupSchedule: runtime.config.backup,
		identity: runtime.identity,
		logger: silentLogger,
		trustedOrigins: [BASE],
		appVersion: APP_VERSION,
		secureCookies: false,
		trustedProxies: ['127.0.0.1'],
	});
}
beforeEach(() => boot([outbox]));
afterEach(() => runtime.close());

let ip = 0;
async function call(method: string, path: string, body?: unknown, cookie?: string) {
	const res = await app.request(`${BASE}${path}`, {
		method,
		headers: {
			origin: BASE,
			'x-forwarded-for': `10.2.0.${++ip}`,
			...(body !== undefined && { 'content-type': 'application/json' }),
			...(cookie && { cookie }),
		},
		...(body !== undefined && { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	return {
		status: res.status,
		body: text ? JSON.parse(text) : null,
		cookie: res.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; '),
	};
}

async function setup() {
	const setupRes = await call('POST', '/api/v1/core/setup', {
		displayName: 'Parent',
		email: 'parent@example.com',
		password: 'correct horse battery',
		locale: 'en',
		setupCode: runtime.config.setupCode,
	});
	expect(setupRes.status).toBe(201);
	const signIn = await call('POST', '/api/auth/sign-in/email', {
		email: 'parent@example.com',
		password: 'correct horse battery',
	});
	return { adminId: setupRes.body.id as string, cookie: signIn.cookie };
}

/** An actor for a member, without signing in (the token service takes the actor). */
const memberActor = (id: string, roleId: string) => ({
	kind: 'member' as const,
	memberId: id as MemberId,
	roleId,
});

async function addMember(cookie: string, displayName: string, roleId: string) {
	const res = await call(
		'POST',
		'/api/v1/actions/core.createMember',
		{ displayName, roleId },
		cookie,
	);
	expect(res.body.status).toBe('applied');
	return res.body.output.id as string;
}

async function enable(cookie: string, on = true) {
	expect((await call('PUT', '/api/v1/mcp/settings', { enabled: on }, cookie)).status).toBe(200);
}

/** Raw JSON-RPC over HTTP, the way any client does it. */
async function rpc(
	secret: string | null,
	body: unknown,
	options: { path?: string; headers?: Record<string, string> } = {},
) {
	const res = await app.request(`${BASE}${options.path ?? '/mcp'}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			'x-forwarded-for': '10.9.0.1',
			...(secret && { authorization: `Bearer ${secret}` }),
			...options.headers,
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	// The 2025-era fallback answers as a one-event stream; the current protocol answers JSON.
	const json = text.startsWith('event:') ? (/^data: (.*)$/m.exec(text)?.[1] ?? '') : text;
	return { status: res.status, headers: res.headers, text, body: json ? JSON.parse(json) : null };
}

/** The 2025-era request shape: no per-request envelope, served statelessly. */
const legacyList = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
const legacyCall = (name: string, args: unknown = {}) => ({
	jsonrpc: '2.0',
	id: 2,
	method: 'tools/call',
	params: { name, arguments: args },
});

async function newToken(
	memberId: string,
	roleId: string,
	scope: 'read' | 'read_write' = 'read_write',
	name = 'Claude Desktop',
) {
	return runtime.kernel.apiTokens.create(memberActor(memberId, roleId), { name, scope });
}

function toolNames(response: { body: { result: { tools: { name: string }[] } } }) {
	return response.body.result.tools.map((t) => t.name);
}

describe('personal API tokens', () => {
	it('creates a token shown once, stores only its hash, lists without secrets, and revokes', async () => {
		const { cookie } = await setup();
		const created = await call(
			'POST',
			'/api/v1/mcp/tokens',
			{ name: 'Laptop', scope: 'read' },
			cookie,
		);
		expect(created.status).toBe(201);
		const secret = created.body.secret as string;
		expect(secret).toMatch(/^famos_[A-Za-z0-9_-]{43}$/);
		expect(created.body.token).toMatchObject({ name: 'Laptop', scope: 'read', revokedAt: null });
		// 90 days by default.
		const days = (created.body.token.expiresAt - created.body.token.createdAt) / 86_400_000;
		expect(days).toBe(90);

		const rows = await runtime.handle.db
			.selectFrom('core_api_tokens' as never)
			.selectAll()
			.execute();
		expect(rows).toHaveLength(1);
		const row = rows[0] as unknown as { token_hash: string };
		expect(row.token_hash).toBe(createHash('sha256').update(secret).digest('hex'));
		expect(JSON.stringify(rows)).not.toContain(secret);

		const list = await call('GET', '/api/v1/mcp/tokens', undefined, cookie);
		expect(list.body.tokens).toHaveLength(1);
		expect(JSON.stringify(list.body)).not.toContain(secret);
		expect(JSON.stringify(list.body)).not.toContain('token_hash');

		const revoked = await call(
			'DELETE',
			`/api/v1/mcp/tokens/${created.body.token.id}`,
			undefined,
			cookie,
		);
		expect(revoked.body.revokedAt).not.toBeNull();
	});

	it('limits the lifetime to a year and needs a name', async () => {
		const { cookie } = await setup();
		const make = (body: object) => call('POST', '/api/v1/mcp/tokens', body, cookie);
		expect((await make({ name: 'x', scope: 'read', expiresInDays: 366 })).status).toBe(400);
		expect((await make({ name: 'x', scope: 'read', expiresInDays: 365 })).status).toBe(201);
		expect((await make({ name: ' ', scope: 'read' })).status).toBe(400);
		expect((await make({ name: 'x', scope: 'write' })).status).toBe(400);
	});

	it('keeps tokens private; an admin sees and revokes everyone’s; guests cannot create', async () => {
		const { adminId, cookie } = await setup();
		const kid = await addMember(cookie, 'Kid', 'supervised');
		const guest = await addMember(cookie, 'Guest', 'guest');
		const mine = await newToken(kid, 'supervised');
		const theirs = await newToken(adminId, 'admin', 'read', 'Admin laptop');

		const kidSees = await runtime.kernel.apiTokens.list(memberActor(kid, 'supervised'));
		expect(kidSees.map((t) => t.id)).toEqual([mine.token.id]);
		await expect(
			runtime.kernel.apiTokens.list(memberActor(kid, 'supervised'), { all: true }),
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(
			runtime.kernel.apiTokens.revoke(memberActor(kid, 'supervised'), theirs.token.id),
		).rejects.toMatchObject({ code: 'not_found' });

		const all = await call('GET', '/api/v1/mcp/tokens?all=true', undefined, cookie);
		expect(all.body.tokens).toHaveLength(2);
		expect(all.body.tokens.map((t: { member: string }) => t.member).sort()).toEqual([
			'Kid',
			'Parent',
		]);
		const gone = await call('DELETE', `/api/v1/mcp/tokens/${mine.token.id}`, undefined, cookie);
		expect(gone.status).toBe(200);

		await expect(newToken(guest, 'guest')).rejects.toMatchObject({ code: 'forbidden' });
	});

	it('revokes a member’s tokens when they are archived', async () => {
		const { cookie } = await setup();
		const kid = await addMember(cookie, 'Kid', 'member');
		await enable(cookie);
		const { secret } = await newToken(kid, 'member');
		expect((await rpc(secret, legacyList)).status).toBe(200);
		const archived = await call(
			'POST',
			'/api/v1/actions/core.archiveMember',
			{ memberId: kid },
			cookie,
		);
		expect(archived.body.status).toBe('applied');
		await vi.waitFor(
			async () => {
				const rows = await runtime.kernel.apiTokens.list(memberActor(kid, 'member'));
				expect(rows[0]?.revokedAt).not.toBeNull();
			},
			{ timeout: 25_000 },
		);
		expect((await rpc(secret, legacyList)).status).toBe(401);
	});
});

describe('the endpoint refuses what it should', () => {
	it('is off until an admin turns it on', async () => {
		const { adminId, cookie } = await setup();
		const { secret } = await newToken(adminId, 'admin');
		expect((await rpc(secret, legacyList)).status).toBe(404);
		// A member who may not manage AI cannot turn it on.
		const kid = await addMember(cookie, 'Kid', 'member');
		await expect(
			runtime.kernel.apiTokens.setEnabled(memberActor(kid, 'member'), true),
		).rejects.toMatchObject({ code: 'forbidden' });
		await enable(cookie);
		expect((await rpc(secret, legacyList)).status).toBe(200);
		await enable(cookie, false);
		expect((await rpc(secret, legacyList)).status).toBe(404);
	});

	it('answers 401 with a JSON-RPC error for missing, unknown, expired and revoked tokens', async () => {
		const { adminId, cookie } = await setup();
		await enable(cookie);

		const missing = await rpc(null, legacyList);
		expect(missing.status).toBe(401);
		expect(missing.body).toMatchObject({ jsonrpc: '2.0', error: { code: -32001 } });
		expect(missing.headers.get('www-authenticate')).toMatch(/^Bearer/);

		expect((await rpc('famos_nope', legacyList)).status).toBe(401);
		expect((await rpc('not-a-famos-token', legacyList)).status).toBe(401);

		const live = await newToken(adminId, 'admin');
		expect((await rpc(live.secret, legacyList)).status).toBe(200);

		const expired = await newToken(adminId, 'admin', 'read', 'Old');
		await runtime.handle.db
			.updateTable('core_api_tokens' as never)
			.set({ expires_at: 1 } as never)
			.where('id' as never, '=', expired.token.id as never)
			.execute();
		expect((await rpc(expired.secret, legacyList)).status).toBe(401);

		await runtime.kernel.apiTokens.revoke(memberActor(adminId, 'admin'), live.token.id);
		expect((await rpc(live.secret, legacyList)).status).toBe(401);
	});

	it('refuses tokens in the query string, even valid ones', async () => {
		const { adminId, cookie } = await setup();
		await enable(cookie);
		const { secret } = await newToken(adminId, 'admin');
		for (const query of [`?token=${secret}`, `?access_token=${secret}`, `?x=${secret}`]) {
			const res = await rpc(null, legacyList, { path: `/mcp${query}` });
			expect(res.status).toBe(401);
			expect(res.text).toContain('Authorization: Bearer');
		}
		// Even with a good header, a token in the address is refused.
		expect((await rpc(secret, legacyList, { path: `/mcp?token=${secret}` })).status).toBe(401);
	});

	it('does not accept a session cookie as authentication', async () => {
		const { cookie } = await setup();
		await enable(cookie);
		const res = await app.request(`${BASE}/mcp`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				cookie,
				origin: BASE,
			},
			body: JSON.stringify(legacyList),
		});
		expect(res.status).toBe(401);
	});

	it('is not blocked by the CSRF check for a foreign origin, since it has no cookies to forge', async () => {
		const { adminId, cookie } = await setup();
		await enable(cookie);
		const { secret } = await newToken(adminId, 'admin');
		const res = await rpc(secret, legacyList, { headers: { origin: 'https://other.example' } });
		expect(res.status).toBe(200);
	});

	it('refuses a member whose role may not use tokens', async () => {
		const { cookie } = await setup();
		await enable(cookie);
		const guest = await addMember(cookie, 'Guest', 'guest');
		// A token made while the member was allowed, then the role lost the capability.
		const member = await addMember(cookie, 'Kid', 'member');
		const { secret, token } = await newToken(member, 'member');
		await runtime.handle.db
			.updateTable('core_members' as never)
			.set({ role_id: 'guest' } as never)
			.where('id' as never, '=', member as never)
			.execute();
		const res = await rpc(secret, legacyList);
		expect(res.status).toBe(403);
		void guest;
		void token;
	});

	it('rate-limits per token', async () => {
		const { adminId, cookie } = await setup();
		await enable(cookie);
		const one = await newToken(adminId, 'admin', 'read', 'One');
		const two = await newToken(adminId, 'admin', 'read', 'Two');
		let last = 0;
		for (let i = 0; i < MCP_RATE_PER_MINUTE; i++) last = (await rpc(one.secret, legacyList)).status;
		expect(last).toBe(200);
		const over = await rpc(one.secret, legacyList);
		expect(over.status).toBe(429);
		expect(over.headers.get('retry-after')).toBe('60');
		// Another token is not affected.
		expect((await rpc(two.secret, legacyList)).status).toBe(200);
	});
});

describe('tools', () => {
	async function family() {
		const { adminId, cookie } = await setup();
		await enable(cookie);
		const kid = await addMember(cookie, 'Kid', 'supervised');
		const admin = await newToken(adminId, 'admin');
		const child = await newToken(kid, 'supervised');
		return { adminId, cookie, kid, admin, child };
	}

	it('offers read and draft tools by scope, and a supervised member fewer', async () => {
		const { adminId, admin, child } = await family();
		const full = toolNames(await rpc(admin.secret, legacyList));
		expect(full).toContain('calendar_findEvents');
		expect(full).toContain('calendar_createEvent');
		// Nothing outside the house, nothing that is not an AI tool, nothing meant for the in-app
		// assistant alone (a personal memory).
		expect(full.some((n) => n.startsWith('outbox_'))).toBe(false);
		expect(full).not.toContain('core_addMemory');

		const readOnly = await newToken(adminId, 'admin', 'read', 'Read only');
		const reads = toolNames(await rpc(readOnly.secret, legacyList));
		expect(reads).toContain('calendar_findEvents');
		expect(reads).not.toContain('calendar_createEvent');

		const supervised = toolNames(await rpc(child.secret, legacyList));
		expect(supervised).toContain('calendar_findEvents');
		// A supervised member proposes (core.drafts.propose) what an edit would apply.
		expect(supervised.length).toBeLessThanOrEqual(full.length);
	});

	it('annotates read tools as read-only and draft tools as non-destructive, closed-world', async () => {
		const { admin } = await family();
		const { body } = await rpc(admin.secret, legacyList);
		const byName = new Map(
			(
				body.result.tools as {
					name: string;
					annotations: Record<string, boolean>;
					description: string;
				}[]
			).map((t) => [t.name, t]),
		);
		expect(byName.get('calendar_findEvents')?.annotations).toMatchObject({
			readOnlyHint: true,
			openWorldHint: false,
		});
		const draft = byName.get('calendar_createEvent');
		expect(draft?.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		});
		expect(draft?.description).toContain('suggestion that a family member approves');
	});

	it('leaves out an area that is off, and a local-only area (the data would leave the house)', async () => {
		const { cookie, admin } = await family();
		const set = (extensionId: string, access: string) =>
			call('POST', '/api/v1/actions/core.setAiAreaAccess', { extensionId, access }, cookie);
		expect(toolNames(await rpc(admin.secret, legacyList))).toContain('calendar_findEvents');

		await set('calendar', 'off');
		let names = toolNames(await rpc(admin.secret, legacyList));
		expect(names.some((n) => n.startsWith('calendar_'))).toBe(false);

		await set('calendar', 'local');
		names = toolNames(await rpc(admin.secret, legacyList));
		expect(names.some((n) => n.startsWith('calendar_'))).toBe(false);
		// Calling it by name does not work either.
		const called = await rpc(
			admin.secret,
			legacyCall('calendar_findEvents', { from: '2026-10-01', to: '2026-10-07' }),
		);
		expect(JSON.stringify(called.body)).toMatch(/not found|unknown|Unknown/i);

		await set('calendar', 'any');
		expect(toolNames(await rpc(admin.secret, legacyList))).toContain('calendar_findEvents');
	});

	it('offers family search only when an embedding model is set, and returns handles', async () => {
		const { cookie, admin } = await family();
		expect(toolNames(await rpc(admin.secret, legacyList))).not.toContain('core_searchFamily');

		// A stand-in embeddings server: a hashed bag of words, like the fake model of the tests.
		const embeddings = http.createServer((req, res) => {
			let raw = '';
			req.on('data', (chunk) => (raw += chunk));
			req.on('end', () => {
				const input = (JSON.parse(raw) as { input: string[] }).input;
				const data = input.map((text, index) => {
					const vector = new Array<number>(64).fill(0);
					for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
						let hash = 7;
						for (const ch of word) hash = (hash * 31 + ch.charCodeAt(0)) % 64;
						vector[hash] = (vector[hash] ?? 0) + 1;
					}
					return { object: 'embedding', index, embedding: vector };
				});
				res.setHeader('content-type', 'application/json');
				res.end(
					JSON.stringify({
						object: 'list',
						data,
						model: 'e',
						usage: { prompt_tokens: 1, total_tokens: 1 },
					}),
				);
			});
		});
		await new Promise<void>((resolve) => embeddings.listen(0, '127.0.0.1', resolve));
		try {
			const provider = await runtime.ai.createProvider({
				name: 'Embeddings',
				kind: 'openai-compatible',
				baseUrl: `http://127.0.0.1:${(embeddings.address() as AddressInfo).port}/v1`,
			});
			await runtime.ai.setRoles({
				...(await runtime.ai.roles()),
				embed: { providerId: provider.id, model: 'e' },
			});
			await runtime.kernel.reconcileSearch();
			expect(toolNames(await rpc(admin.secret, legacyList))).toContain('core_searchFamily');

			const created = await call(
				'POST',
				'/api/v1/actions/calendar.createEvent',
				{ title: 'Boiler service visit', date: '2026-10-20', startTime: '10:00' },
				cookie,
			);
			expect(created.body.status).toBe('applied');
			await runtime.kernel.worker.drain();

			const found = await rpc(
				admin.secret,
				legacyCall('core_searchFamily', { query: 'boiler service' }),
			);
			const text = found.body.result.content[0].text as string;
			expect(text).toContain('Boiler service visit');
			expect(text).toMatch(/cal_event:[0-9a-f]{10}/);
			expect(text).not.toMatch(/cal_event_[0-9a-f]{8}-/);
			// An area that is off for the AI is not searched for it either.
			await call(
				'POST',
				'/api/v1/actions/core.setAiAreaAccess',
				{ extensionId: 'calendar', access: 'off' },
				cookie,
			);
			await runtime.kernel.worker.drain();
			const after = await rpc(
				admin.secret,
				legacyCall('core_searchFamily', { query: 'boiler service' }),
			);
			expect(after.body.result.content[0].text as string).not.toContain('Boiler service visit');
		} finally {
			await new Promise<void>((resolve) => embeddings.close(() => resolve()));
		}
	});

	it('returns handles, not ids, that stay valid across requests; invented ones are refused', async () => {
		const { cookie, admin } = await family();
		const added = await call(
			'POST',
			'/api/v1/actions/vehicles.addVehicle',
			{ name: 'Clio', plate: '34 ABC 123' },
			cookie,
		);
		expect(added.body.status).toBe('applied');
		const vehicleId = added.body.output.id as string;

		const first = await rpc(admin.secret, legacyCall('vehicles_aiContext'));
		const text = first.body.result.content[0].text as string;
		expect(text).toContain('Clio');
		expect(text).not.toContain(vehicleId);
		expect(text).not.toMatch(/vehicle_[0-9a-f]{8}-/);
		const handle = /vehicle:[0-9a-f]{10}/.exec(text)?.[0] as string;
		expect(handle).toBeDefined();
		// The same record has the same handle in the next request, and another token sees another one.
		const second = await rpc(admin.secret, legacyCall('vehicles_aiContext'));
		expect(second.body.result.content[0].text).toContain(handle);
		const other = await newToken(
			(await runtime.kernel.ctx.family.members())[0]?.id as string,
			'admin',
			'read_write',
			'Other',
		);
		const otherText = (await rpc(other.secret, legacyCall('vehicles_aiContext'))).body.result
			.content[0].text as string;
		expect(otherText).not.toContain(handle);

		// A draft in a later request uses the handle; the draft holds the real id.
		const drafted = await rpc(
			admin.secret,
			legacyCall('vehicles_addLog', { vehicleId: handle, doneOn: '2026-10-01', kind: 'service' }),
		);
		expect(drafted.body.result.content[0].text).toContain('"status":"drafted"');
		// The sentence names the suggestion by its title, not by the action's description.
		expect(drafted.body.result.content[0].text).toMatch(
			/"say":"Suggested, not added yet: [^"]*\. It appears/,
		);
		expect(drafted.body.result.content[0].text).not.toContain('Adds ');
		const drafts = await runtime.handle.db
			.selectFrom('core_drafts' as never)
			.selectAll()
			.execute();
		const draft = drafts[0] as unknown as { input: string; source_kind: string };
		expect(JSON.parse(draft.input).vehicleId).toBe(vehicleId);

		// An id that was never shown is refused: neither a made-up handle nor a raw id works.
		const invented = await rpc(
			admin.secret,
			legacyCall('vehicles_addLog', { vehicleId: 'vehicle:0123456789', doneOn: '2026-10-01' }),
		);
		expect(invented.body.result.isError).toBe(true);
		const raw = await rpc(
			admin.secret,
			legacyCall('vehicles_addLog', { vehicleId, doneOn: '2026-10-01' }),
		);
		expect(raw.body.result.isError).toBe(true);
		// The other token was never shown this handle either.
		const stolen = await rpc(
			other.secret,
			legacyCall('vehicles_addLog', { vehicleId: handle, doneOn: '2026-10-01' }),
		);
		expect(stolen.body.result.isError).toBe(true);
	});

	it('turns a draft tool call into a draft from MCP on behalf of the member, and records the call', async () => {
		const { kid, child } = await family();
		const res = await rpc(
			child.secret,
			legacyCall('calendar_createEvent', {
				title: 'Dentist',
				date: '2026-10-20',
				allDay: true,
				memberIds: [],
				tags: [],
			}),
		);
		expect(res.body.result.content[0].text).toContain('"status":"drafted"');
		const drafts = await runtime.handle.db
			.selectFrom('core_drafts' as never)
			.selectAll()
			.execute();
		expect(drafts).toHaveLength(1);
		const draft = drafts[0] as unknown as {
			status: string;
			source_kind: string;
			proposed_by: string;
			action_id: string;
		};
		expect(draft).toMatchObject({
			status: 'pending',
			source_kind: 'mcp',
			action_id: 'calendar.createEvent',
		});
		expect(JSON.parse(draft.proposed_by)).toMatchObject({
			kind: 'ai',
			source: 'mcp',
			onBehalfOf: kid,
		});
		// No event exists yet.
		const events = await rpc(
			child.secret,
			legacyCall('calendar_findEvents', { from: '2026-10-01', to: '2026-10-31' }),
		);
		expect(events.body.result.content[0].text).not.toContain('Dentist');

		const activity = await runtime.ai.activity();
		expect(activity.entries.length).toBeGreaterThanOrEqual(2);
		expect(activity.entries[0]).toMatchObject({
			feature: 'mcp',
			provider: 'MCP',
			model: 'Claude Desktop',
			memberId: kid,
			areas: ['calendar'],
			errorCode: null,
			inputTokens: null,
		});
	});

	it('tells the agent which event is already there for the person to move instead', async () => {
		const { adminId, admin } = await family();
		const made = await runtime.kernel.runner.invoke(
			'calendar.createEvent',
			{ title: 'Regional Gala', date: '2026-11-07', startTime: '18:00' },
			memberActor(adminId, 'admin'),
		);
		expect(made.status).toBe('applied');
		// What a connected agent sent for "the regional gala moved to Sat 14 Nov 09:00".
		const res = await rpc(
			admin.secret,
			legacyCall('calendar_createEvent', {
				title: 'Regional gala',
				date: '2026-11-14',
				startTime: '09:00',
			}),
		);
		const text = res.body.result.content[0].text as string;
		expect(text).toContain('"status":"drafted"');
		expect(text).toContain(
			'Already there: Regional Gala, 2026-11-07 18:00; the person can move it to 2026-11-14 09:00 instead when deciding.',
		);
		// The agent only suggests: the draft is still the new event until a person chooses.
		const drafts = (await runtime.handle.db
			.selectFrom('core_drafts' as never)
			.select(['action_id' as never, 'status' as never])
			.execute()) as unknown as { action_id: string; status: string }[];
		expect(drafts).toEqual([{ action_id: 'calendar.createEvent', status: 'pending' }]);
	});

	it('reports only the suggestions made through its own app key, with who decided them', async () => {
		const { adminId } = await family();
		const hermes = await newToken(adminId, 'admin', 'read_write', 'Hermes');
		const other = await newToken(adminId, 'admin', 'read_write', 'Another app');
		const suggest = (secret: string, title: string) =>
			rpc(
				secret,
				legacyCall('calendar_createEvent', {
					title,
					date: '2026-10-20',
					allDay: true,
					memberIds: [],
					tags: [],
				}),
			);
		await suggest(hermes.secret, 'Delft project call');
		await suggest(other.secret, 'Maas footbridge entry');
		const drafts = (await runtime.handle.db
			.selectFrom('core_drafts' as never)
			.selectAll()
			.execute()) as unknown as { id: string; proposed_by: string }[];
		expect(drafts.map((d) => JSON.parse(d.proposed_by).sourceId).toSorted()).toEqual(
			[hermes.token.id, other.token.id].toSorted(),
		);
		for (const d of drafts)
			await runtime.kernel.runner.approveDraft(d.id, memberActor(adminId, 'admin'));

		const res = await rpc(hermes.secret, legacyCall('core_mySuggestions', {}));
		const text = res.body.result.content[0].text as string;
		expect(text).toContain('Delft project call');
		expect(text).not.toContain('Maas footbridge');
		// Who decided it, as a reference the people list resolves (never a raw id).
		expect(text).toMatch(/"decidedBy":"member:[0-9a-f]+"/);
		expect(text).not.toContain(adminId);
	});

	it('never lists a read-only token’s draft tools, and refuses to call one', async () => {
		const { adminId, cookie } = await family();
		void cookie;
		const readOnly = await newToken(adminId, 'admin', 'read', 'Read only');
		const res = await rpc(
			readOnly.secret,
			legacyCall('calendar_createEvent', { title: 'x', date: '2026-10-20', allDay: true }),
		);
		expect(JSON.stringify(res.body)).toMatch(/not found|unknown|Unknown/i);
		const drafts = await runtime.handle.db
			.selectFrom('core_drafts' as never)
			.selectAll()
			.execute();
		expect(drafts).toHaveLength(0);
	});
});

describe('protocol', () => {
	it('talks the current protocol through the official client, and discovers the server', async () => {
		const { adminId, cookie } = await setup();
		await enable(cookie);
		const { secret } = await newToken(adminId, 'admin');
		const client = new Client({ name: 'test', version: '1.0.0' });
		const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
			fetch: async (input, init) => app.request(input as string, init),
			requestInit: {
				headers: { authorization: `Bearer ${secret}`, 'x-forwarded-for': '10.9.0.2' },
			},
		});
		await client.connect(transport);
		const tools = await client.listTools();
		expect(tools.tools.map((t) => t.name)).toContain('calendar_findEvents');
		expect(client.getServerVersion()?.name).toBe('FamilyOS');
		expect(client.getInstructions()).toMatch(
			/When this connection started it was \w+day, \d{4}-\d{2}-\d{2}/,
		);
		expect(client.getInstructions()).toContain('Call core_today for the current date');
		const result = await client.callTool({
			name: 'calendar_findEvents',
			arguments: { from: '2026-10-01', to: '2026-10-31' },
		});
		expect(JSON.stringify(result)).toContain('tool_result');
		await client.close();
	});

	it('serves the older stateless handshake and refuses sessions it does not keep', async () => {
		const { adminId, cookie } = await setup();
		await enable(cookie);
		const { secret } = await newToken(adminId, 'admin');
		const init = await rpc(secret, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-11-25',
				capabilities: {},
				clientInfo: { name: 'old', version: '1' },
			},
		});
		expect(init.status).toBe(200);
		expect(init.body.result.serverInfo.name).toBe('FamilyOS');
		expect(init.headers.get('mcp-session-id')).toBeNull();
		const get = await app.request(`${BASE}/mcp`, {
			method: 'GET',
			headers: { authorization: `Bearer ${secret}`, accept: 'text/event-stream' },
		});
		expect(get.status).toBe(405);
	});
});
