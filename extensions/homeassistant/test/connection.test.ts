import { type Actor, ExternalHttpError } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Connection } from '../src/contract/index.ts';
import homeassistant from '../src/server/index.ts';
import { tables } from '../src/server/store.ts';
import { connectHomeAssistant } from './connect.ts';

const BASE = 'http://192.168.1.20:8123';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.sentinel-payload.sentinel-signature';

/** A realistic `/api/config`: most of it is private and must not be kept. */
const CONFIG = JSON.stringify({
	latitude: 52.3601,
	longitude: 4.8866,
	elevation: 7,
	unit_system: { length: 'km', temperature: '°C' },
	location_name: 'Home',
	time_zone: 'Europe/Amsterdam',
	components: ['sensor', 'person', 'zone'],
	config_dir: '/config',
	allowlist_external_dirs: ['/config/www'],
	version: '2026.10.2',
	external_url: 'https://ha.example.net',
	internal_url: 'http://192.168.1.20:8123',
	currency: 'EUR',
	// Longer than a real code, so it cannot turn up by chance inside sealed random bytes.
	country: 'sentinel-country',
});

let k: TestKernel;
let admin: Actor;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [homeassistant] });
	admin = (await k.member('admin')).actor;
});
afterEach(() => k.close());

const serveHomeAssistant = (base = BASE) => {
	k.http.serve(`${base}/api/`, { text: '{"message":"API running."}' });
	k.http.serve(`${base}/api/config`, { text: CONFIG });
};

const connect = (url = BASE, token = TOKEN, who: Actor = admin) =>
	connectHomeAssistant(k, who, url, token);

const auditRows = async () =>
	(
		await sql<{ action_id: string; outcome: string; target: string | null; actor: string }>`
			select action_id, outcome, target, actor from core_audit_log where action_id like 'homeassistant.%'`.execute(
			k.ctx.db,
		)
	).rows;

const row = () =>
	tables(k.ctx.db).selectFrom('homeassistant_connection').selectAll().executeTakeFirst();

const route = async (actor: Actor = admin): Promise<Connection> =>
	k.route('homeassistant.getConnection').call({ actor });

/** Everything every table holds, as text. */
async function everythingStored(): Promise<string> {
	const names = await sql<{
		name: string;
	}>`select name from sqlite_master where type = 'table'`.execute(k.ctx.db);
	const parts: string[] = [];
	for (const { name } of names.rows) {
		const rows = await sql`select * from ${sql.table(name)}`.execute(k.ctx.db);
		parts.push(JSON.stringify(rows.rows));
	}
	return parts.join('\n');
}

describe('connect', () => {
	it('stores the address, seals the token and asks for a check', async () => {
		serveHomeAssistant();
		const out = await connect('  HTTP://192.168.1.20:8123/api/ ');
		expect(out).toEqual({
			connected: true,
			address: { scheme: 'http', host: '192.168.1.20', port: 8123, path: null },
			status: 'checking',
			checkedAt: null,
			version: null,
			name: null,
		});
		const stored = await row();
		expect(stored?.base_url).toBe(BASE);
		expect(stored?.status).toBe('checking');
		expect(stored?.sealed_token).not.toBe(TOKEN);
		expect(stored?.sealed_token).not.toContain(TOKEN);
		expect(k.ctx.secrets).toBeDefined();
		expect(k.contextFor('homeassistant').secrets.open(stored?.sealed_token ?? '')).toBe(TOKEN);
		// Nothing has gone out until the job runs.
		expect(k.http.requests).toHaveLength(0);
		const queued = await sql<{ name: string }>`select name from queue_jobs`.execute(k.ctx.db);
		expect(queued.rows.map((j) => j.name)).toContain('homeassistant.check');
	});

	it('refuses addresses and tokens that are not acceptable', async () => {
		for (const url of [
			'ftp://192.168.1.20',
			'http://user:pass@192.168.1.20:8123',
			'http://192.168.1.20:8123/?a=1',
			'192.168.1.20',
			'',
		]) {
			await expect(connect(url, TOKEN)).rejects.toBeDefined();
		}
		for (const token of ['', '   ', 'two words', 'a'.repeat(1025)]) {
			await expect(connect(BASE, token)).rejects.toBeDefined();
		}
		expect(await row()).toBeUndefined();
	});

	it('trims the token', async () => {
		serveHomeAssistant();
		await connect(BASE, `  ${TOKEN}\n`);
		await k.worker.drain();
		expect(k.http.requests[0]?.headers?.authorization).toBe(`Bearer ${TOKEN}`);
	});

	it('is for people who manage the connection only', async () => {
		const member = (await k.member('member')).actor;
		const child = (await k.member('supervised')).actor;
		const saved = k.registry.routes.find(
			(r) => r.route.operationId === 'homeassistant.saveConnection',
		);
		// The HTTP adapter turns the route's capability into a refusal before the handler runs.
		expect(saved?.route.requires).toBe('homeassistant.manage');
		expect(k.access.can(admin, 'homeassistant.manage')).toBe(true);
		for (const who of [member, child]) {
			expect(k.access.can(who, 'homeassistant.manage')).toBe(false);
			await expect(k.runner.invoke('homeassistant.check', {}, who)).rejects.toMatchObject({
				code: 'forbidden',
			});
			await expect(k.runner.invoke('homeassistant.disconnect', {}, who)).rejects.toMatchObject({
				code: 'forbidden',
			});
		}
		expect(await row()).toBeUndefined();
	});

	it('needs a person at a password sign-in', async () => {
		const pin: Actor = { ...admin, pin: true } as Actor;
		const app: Actor = { kind: 'app', appId: 'app_1' } as unknown as Actor;
		const ai: Actor = { kind: 'ai', mode: 'agent', source: 'mcp' } as Actor;
		const display: Actor = { kind: 'display', deviceId: 'dev_1' } as unknown as Actor;
		for (const who of [pin, app, ai, display]) {
			await expect(connect(BASE, TOKEN, who)).rejects.toBeDefined();
		}
		expect(await row()).toBeUndefined();
		expect(await auditRows()).toEqual([]);
	});

	it('may record only its own operations in the audit log', async () => {
		const audit = k.contextFor('homeassistant').audit;
		await expect(audit.record(admin, 'core.setMemberPin', 'x')).rejects.toThrow(/may not record/);
		expect(await auditRows()).toEqual([]);
	});

	it('is not an action: the token is no input of anything the AI can run or propose', async () => {
		expect(k.registry.actions.has('homeassistant.connect')).toBe(false);
		for (const [id, action] of k.registry.actions) {
			if (!id.startsWith('homeassistant.')) continue;
			expect(JSON.stringify(action.input.toJSONSchema()), id).not.toContain('token');
		}
		for (const id of ['homeassistant.check', 'homeassistant.disconnect']) {
			expect(k.registry.actions.get(id)?.ai, id).toBeUndefined();
		}
	});

	it('records itself in the audit log, without the token', async () => {
		serveHomeAssistant();
		await connect();
		const rows = await auditRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			action_id: 'homeassistant.saveConnection',
			outcome: 'applied',
			target: 'home',
		});
		expect(JSON.parse(rows[0]?.actor ?? '{}')).toMatchObject({ kind: 'member', roleId: 'admin' });
		expect(JSON.stringify(rows)).not.toContain('sentinel');
	});

	it('leaves the token in no stored row and in no event', async () => {
		serveHomeAssistant();
		const seen: string[] = [];
		k.bus.onAny((name, payload) => void seen.push(JSON.stringify({ name, payload })));
		const out = await connect();
		await k.worker.drain();
		await k.runner.invoke('homeassistant.check', {}, admin);
		await k.worker.drain();
		const stored = await everythingStored();
		expect(stored).not.toContain(TOKEN);
		expect(stored).not.toContain('sentinel-payload');
		expect(JSON.stringify(out)).not.toContain('sentinel');
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.join('\n')).not.toContain('sentinel');
		// The change was recorded without it, too.
		expect(await route()).not.toHaveProperty('token');
	});

	it('changes the connection: a new address and token are checked again', async () => {
		serveHomeAssistant();
		await connect();
		await k.worker.drain();
		expect((await row())?.status).toBe('ok');
		const created = (await row())?.created_at;
		k.clock.advance(1000);
		serveHomeAssistant('https://ha.example.net');
		await connect('https://ha.example.net/', 'another-token');
		const changed = await row();
		expect(changed).toMatchObject({
			base_url: 'https://ha.example.net',
			status: 'checking',
			checked_at: null,
			ha_version: null,
			ha_name: null,
			created_at: created,
		});
		await k.worker.drain();
		expect((await row())?.status).toBe('ok');
		expect(k.http.requests.at(-1)?.headers?.authorization).toBe('Bearer another-token');
	});
});

describe('the check', () => {
	it('stores the status, the version and the name and drops the rest', async () => {
		serveHomeAssistant();
		k.clock.set(1_800_000_000_000);
		await connect();
		await k.worker.drain();
		expect(await row()).toMatchObject({
			status: 'ok',
			ha_version: '2026.10.2',
			ha_name: 'Home',
			checked_at: 1_800_000_000_000,
		});
		const stored = await everythingStored();
		for (const secret of [
			'52.3601',
			'4.8866',
			'config_dir',
			'allowlist',
			'ha.example.net',
			'sentinel-country',
		]) {
			expect(stored, secret).not.toContain(secret);
		}
		expect(await route()).toEqual({
			connected: true,
			address: { scheme: 'http', host: '192.168.1.20', port: 8123, path: null },
			status: 'ok',
			checkedAt: 1_800_000_000_000,
			version: '2026.10.2',
			name: 'Home',
		});
	});

	it('only reads, from the two endpoints, with the token and the limits', async () => {
		serveHomeAssistant();
		await connect();
		await k.worker.drain();
		expect(k.http.requests.map((r) => r.url)).toEqual([`${BASE}/api/`, `${BASE}/api/config`]);
		for (const request of k.http.requests) {
			expect(request).toMatchObject({
				allowLocal: true,
				headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' },
				timeoutMs: 10_000,
				maxBytes: 64 * 1024,
			});
		}
	});

	it('asks under the path prefix of a reverse proxy', async () => {
		serveHomeAssistant('https://example.net/ha');
		await connect('https://example.net/ha/api');
		await k.worker.drain();
		expect(k.http.requests.map((r) => r.url)).toEqual([
			'https://example.net/ha/api/',
			'https://example.net/ha/api/config',
		]);
		expect((await row())?.status).toBe('ok');
	});

	it.each([
		['http_401', 'token_refused'],
		['http_403', 'token_refused'],
		['http_404', 'not_home_assistant'],
		['blocked_address', 'blocked_address'],
		['timeout', 'timeout'],
		['unreachable', 'unreachable'],
		['bad_url', 'unreachable'],
		['http_500', 'failed'],
		['too_large', 'failed'],
	] as const)('maps %s to %s', async (code, status) => {
		k.http.serve(`${BASE}/api/`, new ExternalHttpError(code));
		await connect();
		await k.worker.drain();
		expect(await row()).toMatchObject({ status, ha_version: null, ha_name: null });
		expect((await route()) as { status: string }).toMatchObject({ status });
	});

	it('is not Home Assistant when the answer is not its answer', async () => {
		for (const text of ['<html>Welcome</html>', '{"status":"ok"}', '[]']) {
			k.http.serve(`${BASE}/api/`, { text });
			await connect();
			await k.worker.drain();
			expect((await row())?.status, text).toBe('not_home_assistant');
		}
		// The root answers, the configuration does not make sense.
		k.http.serve(`${BASE}/api/`, { text: '{"message":"API running."}' });
		k.http.serve(`${BASE}/api/config`, { text: 'nope' });
		await connect();
		await k.worker.drain();
		expect((await row())?.status).toBe('not_home_assistant');
	});

	it('can be asked for again, once', async () => {
		k.http.serve(`${BASE}/api/`, new ExternalHttpError('http_401'));
		await connect();
		await k.worker.drain();
		expect((await row())?.status).toBe('token_refused');
		serveHomeAssistant();
		k.clock.advance(5000);
		await k.runner.invoke('homeassistant.check', {}, admin);
		expect((await row())?.status).toBe('checking');
		// A second click while it checks changes nothing and starts nothing.
		await k.runner.invoke('homeassistant.check', {}, admin);
		await k.worker.drain();
		expect((await row())?.status).toBe('ok');
		expect(k.http.requests.filter((r) => r.url === `${BASE}/api/config`)).toHaveLength(1);
	});

	it('can be asked for again when a check never answered', async () => {
		serveHomeAssistant();
		// The server stopped before the worker ran the check: the row stays "checking".
		await connect();
		await k.runner.invoke('homeassistant.check', {}, admin);
		expect(k.http.requests).toHaveLength(0);
		k.clock.advance(3 * 60_000);
		await k.runner.invoke('homeassistant.check', {}, admin);
		await k.worker.drain();
		expect((await row())?.status).toBe('ok');
	});

	it('leaves a connection that changed while it ran alone', async () => {
		serveHomeAssistant();
		serveHomeAssistant('https://ha.example.net');
		await connect();
		const get = k.http.get.bind(k.http);
		let changedOnce = false;
		k.http.get = async (request) => {
			if (!changedOnce) {
				changedOnce = true;
				k.clock.advance(10);
				await connect('https://ha.example.net', 'another-token');
			}
			return get(request);
		};
		await k.worker.drain();
		// The first check's answer was for the old address and was not written; the second one ran.
		expect(await row()).toMatchObject({ base_url: 'https://ha.example.net', status: 'ok' });
		expect(k.http.requests.at(-1)?.headers?.authorization).toBe('Bearer another-token');
	});

	it('does not bring a connection back that was disconnected while it ran', async () => {
		serveHomeAssistant();
		await connect();
		const get = k.http.get.bind(k.http);
		k.http.get = async (request) => {
			await k.runner.invoke('homeassistant.disconnect', {}, admin);
			return get(request);
		};
		await k.worker.drain();
		expect(await row()).toBeUndefined();
		expect(await route()).toEqual({ connected: false });
	});

	it('does nothing when the connection is gone before it runs', async () => {
		serveHomeAssistant();
		await connect();
		await k.runner.invoke('homeassistant.disconnect', {}, admin);
		await k.worker.drain();
		expect(k.http.requests).toHaveLength(0);
		expect(await row()).toBeUndefined();
	});

	it('is failed when the token can no longer be opened', async () => {
		serveHomeAssistant();
		await connect();
		await tables(k.ctx.db)
			.updateTable('homeassistant_connection')
			.set({ sealed_token: 'not sealed by us' })
			.execute();
		await k.worker.drain();
		expect((await row())?.status).toBe('failed');
		expect(k.http.requests).toHaveLength(0);
	});
});

describe('disconnect and the route', () => {
	it('forgets the token with the row', async () => {
		serveHomeAssistant();
		await connect();
		await k.worker.drain();
		expect(await k.runner.invoke('homeassistant.disconnect', {}, admin)).toMatchObject({
			status: 'applied',
		});
		expect(await row()).toBeUndefined();
		expect(await everythingStored()).not.toContain('sentinel');
		expect(await route()).toEqual({ connected: false });
		// Checking what is not there is refused.
		await expect(k.runner.invoke('homeassistant.check', {}, admin)).rejects.toMatchObject({
			code: 'not_found',
		});
	});

	it('shows a path and a port, and never the token or a hint of it', async () => {
		serveHomeAssistant('https://example.net:8443/ha');
		await connect('https://Example.net:8443/ha/');
		await k.worker.drain();
		const view = await route();
		expect(view).toMatchObject({
			connected: true,
			address: { scheme: 'https', host: 'example.net', port: 8443, path: '/ha' },
		});
		expect(JSON.stringify(view)).not.toContain('sentinel');
		expect(Object.keys(view).sort()).toEqual(
			['address', 'checkedAt', 'connected', 'name', 'status', 'version'].sort(),
		);
	});

	it('is for people who manage the connection only', async () => {
		// The host checks a route's `requires` before it runs.
		const declared = k.registry.routes.find(
			(r) => r.route.operationId === 'homeassistant.getConnection',
		);
		expect(declared?.route.requires).toBe('homeassistant.manage');
		const member = (await k.member('member')).actor;
		const child = (await k.member('supervised')).actor;
		expect(k.access.can(admin, 'homeassistant.manage')).toBe(true);
		expect(k.access.can(member, 'homeassistant.manage')).toBe(false);
		expect(k.access.can(child, 'homeassistant.manage')).toBe(false);
	});
});

describe('test the connection before saving', () => {
	const test = (url = BASE, token = TOKEN) =>
		k.route('homeassistant.testConnection').call({ actor: admin, body: { url, token } });

	it('finds the name and the version and stores nothing', async () => {
		serveHomeAssistant();
		expect(await test('HTTP://192.168.1.20:8123/api/')).toEqual({
			status: 'ok',
			version: '2026.10.2',
			name: 'Home',
		});
		expect(await row()).toBeUndefined();
		expect(await everythingStored()).not.toContain('sentinel');
		// Only reads, and a short wait: a person is waiting.
		expect(k.http.requests.map((r) => r.url)).toEqual([`${BASE}/api/`, `${BASE}/api/config`]);
	});

	it('gives both reads one shared deadline of 6 seconds', async () => {
		serveHomeAssistant();
		const get = k.http.get.bind(k.http);
		k.http.get = async (request) => {
			// The first read takes a while; the second may only use what is left.
			if (request.url.endsWith('/api/')) await new Promise((done) => setTimeout(done, 40));
			return get(request);
		};
		await test();
		const [first, second] = k.http.requests.map((r) => r.timeoutMs ?? 0);
		expect(first).toBeLessThanOrEqual(6_000);
		expect(first).toBeGreaterThan(5_000);
		expect((first ?? 0) - 1).toBeGreaterThanOrEqual(second ?? 0);
		expect(second).toBeLessThan((first ?? 0) - 30);
	});

	it('does not touch a connection that already exists', async () => {
		serveHomeAssistant();
		await connect();
		await k.worker.drain();
		const before = await row();
		k.http.serve('http://192.168.1.99:8123/api/', new ExternalHttpError('http_401'));
		expect(await test('http://192.168.1.99:8123')).toMatchObject({ status: 'token_refused' });
		expect(await row()).toEqual(before);
	});

	it.each([
		['http_401', 'token_refused'],
		['http_404', 'not_home_assistant'],
		['timeout', 'timeout'],
		['unreachable', 'unreachable'],
		['blocked_address', 'blocked_address'],
		['http_500', 'failed'],
	] as const)('answers %s as %s, as the check does', async (code, status) => {
		k.http.serve(`${BASE}/api/`, new ExternalHttpError(code));
		expect(await test()).toEqual({ status, version: null, name: null });
	});

	it('says an answer that is not Home Assistant is not', async () => {
		k.http.serve(`${BASE}/api/`, { text: '<html>router</html>' });
		expect(await test()).toMatchObject({ status: 'not_home_assistant' });
	});

	it('refuses an address that is not an http address', async () => {
		await expect(test('ftp://192.168.1.20')).rejects.toBeDefined();
		expect(k.http.requests).toEqual([]);
	});

	it('is for people who manage the connection only', async () => {
		const declared = k.registry.routes.find(
			(r) => r.route.operationId === 'homeassistant.testConnection',
		);
		expect(declared?.route.requires).toBe('homeassistant.manage');
	});
});
