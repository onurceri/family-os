import { type Actor, ExternalHttpError } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Connection } from '../src/contract/index.ts';
import homeassistant from '../src/server/index.ts';
import { tables } from '../src/server/store.ts';

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
	country: 'NL',
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

async function connect(url = BASE, token = TOKEN) {
	const r = await k.runner.invoke<Connection>('homeassistant.connect', { url, token }, admin);
	if (r.status !== 'applied') throw new Error('expected applied');
	return r.output;
}

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
			await expect(
				k.runner.invoke('homeassistant.connect', { url, token: TOKEN }, admin),
			).rejects.toBeDefined();
		}
		for (const token of ['', '   ', 'two words', 'a'.repeat(1025)]) {
			await expect(
				k.runner.invoke('homeassistant.connect', { url: BASE, token }, admin),
			).rejects.toBeDefined();
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
		for (const who of [member, child]) {
			await expect(
				k.runner.invoke('homeassistant.connect', { url: BASE, token: TOKEN }, who),
			).rejects.toMatchObject({ code: 'forbidden' });
			await expect(k.runner.invoke('homeassistant.check', {}, who)).rejects.toMatchObject({
				code: 'forbidden',
			});
			await expect(k.runner.invoke('homeassistant.disconnect', {}, who)).rejects.toMatchObject({
				code: 'forbidden',
			});
		}
		expect(await row()).toBeUndefined();
	});

	it('is not something the AI can run or propose', async () => {
		const ai: Actor = { kind: 'ai', source: 'test' } as Actor;
		const r = await k.runner
			.invoke('homeassistant.connect', { url: BASE, token: TOKEN }, ai)
			.catch((e) => e);
		expect(r).not.toMatchObject({ status: 'applied' });
		expect(await row()).toBeUndefined();
		for (const id of ['homeassistant.connect', 'homeassistant.check', 'homeassistant.disconnect']) {
			const action = k.registry.actions.get(id);
			expect(action?.ai, id).toBeUndefined();
		}
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
		for (const secret of ['52.3601', '4.8866', 'config_dir', 'allowlist', 'ha.example.net', 'NL']) {
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
