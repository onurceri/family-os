import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import { type CoreTables, publicPath } from '@famos/core';
import { ERROR_HTTP_STATUS, type MemberId } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http/app.ts';
import { publicOpenApiDocument } from '../src/http/public/index.ts';
import { APP_VERSION, migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { fastPasswordHasher } from './fast-password.ts';
import { discoverSourceExtensions } from './support/extensions.ts';

const extensions = await discoverSourceExtensions();
const BASE = 'http://localhost:3000';
let runtime: Runtime;
let app: ReturnType<typeof createHttpApp>;

beforeEach(async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-public-'));
	const config = await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: BASE });
	runtime = openRuntime(config, {
		logger: silentLogger,
		quiet: true,
		passwordHasher: fastPasswordHasher,
		extensions,
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
});
afterEach(() => runtime.close());

let ip = 0;
const nextIp = () => `10.6.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;

// biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the API answered.
type Reply = { status: number; body: any; headers: Headers };

async function request(
	method: string,
	path: string,
	options: {
		body?: unknown;
		cookie?: string;
		bearer?: string;
		headers?: Record<string, string>;
	} = {},
): Promise<Reply> {
	const res = await app.request(`${BASE}${path}`, {
		method,
		headers: {
			origin: BASE,
			'x-forwarded-for': nextIp(),
			...(options.body !== undefined && { 'content-type': 'application/json' }),
			...(options.cookie && { cookie: options.cookie }),
			...(options.bearer && { authorization: `Bearer ${options.bearer}` }),
			...options.headers,
		},
		...(options.body !== undefined && { body: JSON.stringify(options.body) }),
	});
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

async function setup() {
	const made = await request('POST', '/api/v1/core/setup', {
		body: {
			displayName: 'Parent',
			email: 'parent@example.com',
			password: 'correct horse battery',
			locale: 'en',
			setupCode: runtime.config.setupCode,
		},
	});
	expect(made.status).toBe(201);
	const signIn = await request('POST', '/api/auth/sign-in/email', {
		body: { email: 'parent@example.com', password: 'correct horse battery' },
	});
	const cookie = signIn.headers
		.getSetCookie()
		.map((c) => c.split(';')[0])
		.join('; ');
	return { adminId: made.body.id as string, cookie };
}

async function addApp(
	cookie: string,
	options: { name?: string; roleId: string; mode?: 'apply' | 'suggest'; actsFor?: string[] },
) {
	const created = await request('POST', '/api/v1/apps', {
		cookie,
		body: {
			name: options.name ?? 'Test app',
			roleId: options.roleId,
			mode: options.mode ?? 'apply',
			actsFor: options.actsFor ?? [],
		},
	});
	expect(created.status).toBe(201);
	return { secret: created.body.secret as string, id: created.body.app.id as string };
}

const pub = (
	bearer: string,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
) =>
	request(method, `/api/public/v1${path}`, {
		bearer,
		...(body !== undefined && { body }),
		headers,
	});

async function addMember(cookie: string, displayName: string, roleId: string) {
	const res = await request('POST', '/api/v1/actions/core.createMember', {
		cookie,
		body: { displayName, roleId },
	});
	expect(res.body.status).toBe('applied');
	return res.body.output.id as string;
}

const adminActor = (id: string) => ({
	kind: 'member' as const,
	memberId: id as MemberId,
	roleId: 'admin',
});

describe('the door', () => {
	it('takes a bearer app key and nothing else', async () => {
		const { cookie, adminId } = await setup();
		const { secret } = await addApp(cookie, { roleId: 'admin' });

		const none = await request('GET', '/api/public/v1/');
		expect(none.status).toBe(401);
		expect(none.body.error.code).toBe('unauthenticated');
		expect(none.headers.get('www-authenticate')).toMatch(/^Bearer/);

		expect((await pub('famos_nope', 'GET', '/')).status).toBe(401);

		// A signed-in session is no credential here, whoever it belongs to.
		const withCookie = await request(
			'GET',
			'/api/public/v1/calendar/occurrences?from=2026-10-01&to=2026-10-02',
			{ cookie },
		);
		expect(withCookie.status).toBe(401);

		// A personal (MCP) key is not an app key.
		const personal = await runtime.kernel.apiTokens.create(adminActor(adminId), {
			name: 'mine',
			scope: 'read',
		});
		expect((await pub(personal.secret, 'GET', '/')).status).toBe(401);

		expect((await pub(secret, 'GET', '/')).status).toBe(200);
	});

	it('leaves the app’s own API closed to a bearer', async () => {
		const { cookie } = await setup();
		const { secret } = await addApp(cookie, { roleId: 'admin' });
		const res = await request('GET', '/api/v1/calendar/occurrences?from=2026-10-01&to=2026-10-02', {
			bearer: secret,
		});
		expect(res.status).toBe(400);
	});

	it('turns away a paused or revoked app at once', async () => {
		const { cookie } = await setup();
		const { secret, id } = await addApp(cookie, { roleId: 'admin' });
		await request('POST', `/api/v1/apps/${id}/pause`, { cookie });
		expect((await pub(secret, 'GET', '/')).status).toBe(401);
		await request('POST', `/api/v1/apps/${id}/resume`, { cookie });
		expect((await pub(secret, 'GET', '/')).status).toBe(200);
		await request('DELETE', `/api/v1/apps/${id}`, { cookie });
		expect((await pub(secret, 'GET', '/')).status).toBe(401);
	});

	it('limits wrong keys per address, and every app’s requests', async () => {
		const { cookie } = await setup();
		const { secret } = await addApp(cookie, { roleId: 'admin' });
		const address = { 'x-forwarded-for': '10.99.0.1' };
		let last = 0;
		for (let i = 0; i < 31; i++)
			last = (await request('GET', '/api/public/v1/', { bearer: 'famos_nope', headers: address }))
				.status;
		expect(last).toBe(429);
		// Only wrong keys count against an address.
		expect(
			(await request('GET', '/api/public/v1/', { bearer: secret, headers: address })).status,
		).toBe(200);

		let status = 200;
		for (let i = 0; i < 305 && status === 200; i++)
			status = (await pub(secret, 'GET', '/changes')).status;
		expect(status).toBe(429);
	});

	it('acts for a member only when the app is allowed to', async () => {
		const { cookie } = await setup();
		const leoId = await addMember(cookie, 'Leo', 'member');
		const ivyId = await addMember(cookie, 'Ivy', 'member');
		const { secret } = await addApp(cookie, { roleId: 'member', actsFor: [leoId] });
		const forLeo = await pub(secret, 'GET', '/', undefined, { 'x-familyos-on-behalf-of': leoId });
		expect(forLeo.status).toBe(200);
		expect(forLeo.body.caller.memberId).toBe(leoId);
		const forIvy = await pub(secret, 'GET', '/', undefined, { 'x-familyos-on-behalf-of': ivyId });
		expect(forIvy.status).toBe(403);
		expect(forIvy.body.error).toMatchObject({ code: 'forbidden', reason: 'on_behalf' });
	});
});

describe('the door, more', () => {
	it('refuses a body that is too large, in its own error shape', async () => {
		const { cookie } = await setup();
		const { secret } = await addApp(cookie, { roleId: 'admin' });
		const res = await pub(secret, 'POST', '/board/notes', { text: 'x'.repeat(300 * 1024) });
		expect(res.status).toBe(400);
		expect(res.body.error).toMatchObject({ code: 'bad_request', fields: [{ path: 'body' }] });
	});

	it('serves its own document to a key, naming only what is installed', async () => {
		const { cookie } = await setup();
		const { secret } = await addApp(cookie, { roleId: 'admin' });
		expect((await request('GET', '/api/public/v1/openapi.json')).status).toBe(401);
		const doc = await pub(secret, 'GET', '/openapi.json');
		expect(doc.status).toBe(200);
		expect(doc.body.openapi).toBe('3.1.0');
		expect(Object.keys(doc.body.paths)).toContain('/calendar/events');
		expect(doc.body.paths['/openapi.json']).toBeUndefined();
	});

	it('counts wrong keys together with the MCP endpoint’s', async () => {
		const { cookie } = await setup();
		expect(
			(await request('PUT', '/api/v1/mcp/settings', { cookie, body: { enabled: true } })).status,
		).toBe(200);
		const address = { 'x-forwarded-for': '10.88.0.1' };
		for (let i = 0; i < 30; i++)
			await request('POST', '/mcp', {
				bearer: 'famos_nope',
				body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
				headers: { ...address, accept: 'application/json, text/event-stream' },
			});
		const next = await request('GET', '/api/public/v1/', {
			bearer: 'famos_nope',
			headers: address,
		});
		expect(next.status).toBe(429);
		expect(next.headers.get('retry-after')).toBe('60');
	});

	it('is not part of the app’s own document', async () => {
		const { cookie } = await setup();
		const own = await request('GET', '/api/openapi.json', { cookie });
		expect(Object.keys(own.body.paths).some((p) => p.includes('/api/public'))).toBe(false);
	});
});

describe('discovery', () => {
	it('names the version, the family and the operations this caller may use now', async () => {
		const { cookie } = await setup();
		const admin = await addApp(cookie, { roleId: 'admin' });
		const guest = await addApp(cookie, { roleId: 'guest' });
		const suggest = await addApp(cookie, { roleId: 'admin', mode: 'suggest' });

		const found = await pub(admin.secret, 'GET', '/');
		expect(found.body).toMatchObject({
			api: 'v1',
			familyOS: APP_VERSION,
			timeZone: 'UTC',
			language: 'en',
			caller: { app: { name: 'Test app', mode: 'apply' }, memberId: null },
		});
		expect(found.body.extensions).toEqual(
			expect.arrayContaining([{ id: 'calendar', version: expect.any(String), enabled: true }]),
		);
		// biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the API answered.
		const outcomeOf = (body: any, name: string) =>
			body.operations.find((o: { name: string }) => o.name === name)?.outcome;
		expect(outcomeOf(found.body, 'calendar.createEvent')).toBe('apply');
		expect(outcomeOf(found.body, 'calendar.listOccurrences')).toBe('read');
		const op = found.body.operations.find((o: { name: string }) => o.name === 'calendar.getEvent');
		expect(op).toMatchObject({ method: 'get', path: '/api/public/v1/calendar/events/{eventId}' });

		// A guest app reads and cannot change; a suggesting app's changes wait.
		const asGuest = (await pub(guest.secret, 'GET', '/')).body;
		expect(outcomeOf(asGuest, 'calendar.listOccurrences')).toBe('read');
		expect(outcomeOf(asGuest, 'calendar.createEvent')).toBeUndefined();
		expect(outcomeOf(asGuest, 'lists.addTask')).toBeUndefined();
		const asSuggest = (await pub(suggest.secret, 'GET', '/')).body;
		expect(outcomeOf(asSuggest, 'calendar.createEvent')).toBe('draft');
		expect(outcomeOf(asSuggest, 'calendar.listOccurrences')).toBe('read');
		expect(asSuggest.caller.app.mode).toBe('suggest');
	});

	it('lists the waiting suggestions only to a caller that may read them', async () => {
		const { cookie } = await setup();
		const admin = await addApp(cookie, { roleId: 'admin' });
		const guest = await addApp(cookie, { roleId: 'guest' });
		const asAdmin = (await pub(admin.secret, 'GET', '/')).body.operations.find(
			(o: { name: string }) => o.name === 'core.listDrafts',
		);
		expect(asAdmin).toMatchObject({
			method: 'get',
			path: '/api/public/v1/drafts',
			outcome: 'read',
		});
		// The guest role cannot suggest, so it cannot read them: the call is refused too.
		const asGuest = (await pub(guest.secret, 'GET', '/')).body.operations.map(
			(o: { name: string }) => o.name,
		);
		expect(asGuest).not.toContain('core.listDrafts');
		expect((await pub(guest.secret, 'GET', '/drafts?status=waiting')).status).toBe(403);
	});

	it('lists the active members the app may act for, and nobody else', async () => {
		const { cookie } = await setup();
		const leoId = await addMember(cookie, 'Leo', 'member');
		const ivyId = await addMember(cookie, 'Ivy', 'member');
		const goneId = await addMember(cookie, 'Gone', 'member');
		await addMember(cookie, 'Other', 'member');
		const { secret } = await addApp(cookie, { roleId: 'member', actsFor: [leoId, ivyId, goneId] });
		const none = await addApp(cookie, { roleId: 'member' });
		await request('POST', '/api/v1/actions/core.archiveMember', {
			cookie,
			body: { memberId: goneId },
		});

		const found = await pub(secret, 'GET', '/');
		expect(found.body.actsFor).toEqual(
			expect.arrayContaining([
				{ memberId: leoId, name: 'Leo' },
				{ memberId: ivyId, name: 'Ivy' },
			]),
		);
		expect(found.body.actsFor).toHaveLength(2);
		// The same list when the request already acts for one of them.
		const named = await pub(secret, 'GET', '/', undefined, { 'x-familyos-on-behalf-of': leoId });
		expect(named.body.actsFor).toHaveLength(2);
		expect((await pub(none.secret, 'GET', '/')).body.actsFor).toEqual([]);
	});

	it('follows the member an app acts for', async () => {
		const { cookie } = await setup();
		const kid = await addMember(cookie, 'Kid', 'supervised');
		const { secret } = await addApp(cookie, { roleId: 'admin', actsFor: [kid] });
		const body = (await pub(secret, 'GET', '/', undefined, { 'x-familyos-on-behalf-of': kid }))
			.body;
		const outcomeOf = (name: string) =>
			body.operations.find((o: { name: string }) => o.name === name)?.outcome;
		// The child may only suggest events; the app alone could add them.
		expect(outcomeOf('calendar.createEvent')).toBe('draft');
		expect(outcomeOf('calendar.listOccurrences')).toBe('read');
	});

	it('reflects an extension that is switched off', async () => {
		const { cookie } = await setup();
		const { secret } = await addApp(cookie, { roleId: 'admin' });
		const off = await request('POST', '/api/v1/actions/core.setFeatureEnabled', {
			cookie,
			body: { extensionId: 'board', enabled: false },
		});
		expect(off.body.status).toBe('applied');
		const found = (await pub(secret, 'GET', '/')).body;
		expect(found.extensions).toEqual(
			expect.arrayContaining([{ id: 'board', version: expect.any(String), enabled: false }]),
		);
		expect(found.operations.some((o: { name: string }) => o.name.startsWith('board.'))).toBe(false);
		const refused = await pub(secret, 'GET', '/board/notes');
		expect(refused.status).toBe(404);
		expect(refused.body.error.code).toBe('feature_off');
		const post = await pub(secret, 'POST', '/board/notes', { text: 'hi' });
		expect(post.status).toBe(404);
		expect(post.body.error.code).toBe('feature_off');
	});
});

/** What an admin app makes, for the others to read and change. */
async function fixtures(cookie: string, admin: string) {
	const ok = (r: Reply) => {
		expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
		return r.body.result;
	};
	const event = ok(
		await pub(admin, 'POST', '/calendar/events', {
			title: 'Dentist',
			date: '2026-10-21',
			startTime: '09:00',
		}),
	);
	const second = ok(
		await pub(admin, 'POST', '/calendar/events', {
			title: 'Concert',
			date: '2026-10-22',
			startTime: '20:00',
		}),
	);
	const third = ok(
		await pub(admin, 'POST', '/calendar/events', {
			title: 'Swimming',
			date: '2026-10-23',
			startTime: '10:00',
		}),
	);
	const lists = (await pub(admin, 'GET', '/lists/shopping/lists')).body.items;
	const listId = lists[0].id as string;
	const added = ok(
		await pub(admin, 'POST', `/lists/shopping/lists/${listId}/items`, {
			items: [{ title: 'Milk' }, { title: 'Bread' }, { title: 'Apples' }, { title: 'Tea' }],
		}),
	);
	const bought = added.items.find((i: { title: string }) => i.title === 'Tea');
	await pub(admin, 'POST', `/lists/shopping/items/${bought.id}/complete`, {});
	const tasks = [];
	for (const title of ['Pay the fee', 'Book the vet', 'Sort the cupboard', 'Call the school'])
		tasks.push(ok(await pub(admin, 'POST', '/lists/tasks', { title, dueDate: '2026-10-25' })));
	const doneTask = ok(await pub(admin, 'POST', `/lists/tasks/${tasks[3].id}/complete`, {}));
	const chore = await request('POST', '/api/v1/actions/chores.createChore', {
		cookie,
		body: { title: 'Dishes', startDate: '2026-10-20', recurrence: { freq: 'daily', interval: 1 } },
	});
	expect(chore.body.status).toBe('applied');
	const note = ok(await pub(admin, 'POST', '/board/notes', { text: 'Hello' }));
	return {
		event,
		second,
		third,
		listId,
		added,
		bought,
		tasks,
		doneTask,
		chore: chore.body.output,
		note,
	};
}

/** Calls every exposed operation once as one caller; answers the status of each. */
async function walk(
	secret: string,
	headers: Record<string, string>,
	fx: Awaited<ReturnType<typeof fixtures>> & { adminId: string },
) {
	const out: Record<string, number> = {};
	const call = async (name: string, method: string, path: string, body?: unknown, extra = {}) => {
		out[name] = (await pub(secret, method, path, body, { ...headers, ...extra })).status;
	};
	await call('discover', 'GET', '/');
	await call('changes', 'GET', '/changes');
	// calendar
	await call(
		'calendar.listOccurrences',
		'GET',
		'/calendar/occurrences?from=2026-10-20&to=2026-10-30',
	);
	await call('calendar.getEvent', 'GET', `/calendar/events/${fx.event.id}`);
	await call('calendar.createEvent', 'POST', '/calendar/events', {
		title: 'Swim',
		date: '2026-10-24',
		startTime: '10:00',
	});
	await call('calendar.patchEvent', 'PATCH', `/calendar/events/${fx.event.id}`, {
		location: 'Clinic',
	});
	await call(
		'calendar.replaceEvent',
		'PUT',
		`/calendar/events/${fx.second.id}`,
		{
			event: {
				title: 'Concert',
				allDay: false,
				date: '2026-10-22',
				endDate: null,
				startTime: '20:30',
				endTime: null,
				memberIds: [],
				location: null,
				notes: null,
				recurrence: null,
				reminder: null,
				tags: null,
			},
		},
		{ 'if-match': `"v${fx.second.version}"` },
	);
	await call('calendar.deleteEvent', 'DELETE', `/calendar/events/${fx.third.id}`);
	// shopping
	await call('lists.listShoppingLists', 'GET', '/lists/shopping/lists');
	await call('lists.listShoppingItems', 'GET', `/lists/shopping/lists/${fx.listId}/items`);
	await call('lists.addShoppingItems', 'POST', `/lists/shopping/lists/${fx.listId}/items`, {
		items: [{ title: 'Eggs', quantity: '12' }],
	});
	await call('lists.addShoppingItemsDefault', 'POST', '/lists/shopping/items', {
		items: [{ title: 'Butter' }],
	});
	const [milk, bread, apples] = fx.added.items;
	await call('lists.patchShoppingItem', 'PATCH', `/lists/shopping/items/${milk.id}`, {
		quantity: '2 l',
	});
	await call('lists.completeShoppingItem', 'POST', `/lists/shopping/items/${bread.id}/complete`);
	await call('lists.uncheckShoppingItem', 'POST', `/lists/shopping/items/${fx.bought.id}/uncheck`);
	await call('lists.deleteShoppingItem', 'DELETE', `/lists/shopping/items/${apples.id}`);
	// tasks
	const [t1, t2, t3] = fx.tasks;
	await call('lists.listTasks', 'GET', '/lists/tasks');
	await call('lists.getTask', 'GET', `/lists/tasks/${t1.id}`);
	await call('lists.addTask', 'POST', '/lists/tasks', { title: 'Water the plants' });
	await call(
		'lists.replaceTask',
		'PUT',
		`/lists/tasks/${t1.id}`,
		{
			task: {
				title: 'Pay the school fee',
				assigneeId: null,
				dueDate: '2026-10-26',
				dueTime: null,
				recurrence: null,
				notes: null,
			},
		},
		{ 'if-match': `${t1.version}` },
	);
	await call('lists.patchTask', 'PATCH', `/lists/tasks/${t2.id}`, { notes: 'Thursday' });
	await call('lists.completeTask', 'POST', `/lists/tasks/${t2.id}/complete`);
	await call('lists.reopenTask', 'POST', `/lists/tasks/${fx.doneTask.id}/reopen`);
	await call('lists.deleteTask', 'DELETE', `/lists/tasks/${t3.id}`);
	// chores
	await call('chores.listChores', 'GET', '/chores');
	await call('chores.getChore', 'GET', `/chores/${fx.chore.id}`);
	await call('chores.completeChore', 'POST', `/chores/${fx.chore.id}/complete`, {
		dueDate: fx.chore.nextDue,
		...(headers['x-familyos-on-behalf-of'] ? {} : { doneBy: fx.adminId }),
	});
	// board
	await call('board.listNotes', 'GET', '/board/notes');
	await call('board.createNote', 'POST', '/board/notes', { text: 'Back at six' });
	return out;
}

/** What each caller gets for every operation, when the operations are made fresh for it. */
const FULL: Record<string, number> = {
	discover: 200,
	changes: 200,
	'calendar.listOccurrences': 200,
	'calendar.getEvent': 200,
	'calendar.createEvent': 201,
	'calendar.patchEvent': 200,
	'calendar.replaceEvent': 200,
	'calendar.deleteEvent': 200,
	'lists.listShoppingLists': 200,
	'lists.listShoppingItems': 200,
	'lists.addShoppingItems': 201,
	'lists.addShoppingItemsDefault': 201,
	'lists.patchShoppingItem': 200,
	'lists.completeShoppingItem': 200,
	'lists.uncheckShoppingItem': 200,
	'lists.deleteShoppingItem': 200,
	'lists.listTasks': 200,
	'lists.getTask': 200,
	'lists.addTask': 201,
	'lists.replaceTask': 200,
	'lists.patchTask': 200,
	'lists.completeTask': 200,
	'lists.reopenTask': 200,
	'lists.deleteTask': 200,
	'chores.listChores': 200,
	'chores.getChore': 200,
	'chores.completeChore': 200,
	'board.listNotes': 200,
	'board.createNote': 201,
};
/** A role that may only suggest what needs an editor: those changes wait (202). */
const SUGGESTS: Record<string, number> = {
	...FULL,
	'calendar.createEvent': 202,
	'calendar.patchEvent': 202,
	'calendar.replaceEvent': 202,
	'calendar.deleteEvent': 202,
	'lists.deleteShoppingItem': 202,
	'lists.addTask': 202,
	'lists.replaceTask': 202,
	'lists.patchTask': 202,
	'lists.deleteTask': 202,
};
const READS = new Set([
	'discover',
	'changes',
	'calendar.listOccurrences',
	'calendar.getEvent',
	'lists.listShoppingLists',
	'lists.listShoppingItems',
	'lists.listTasks',
	'lists.getTask',
	'chores.listChores',
	'chores.getChore',
	'board.listNotes',
]);
const READS_ONLY: Record<string, number> = Object.fromEntries(
	Object.keys(FULL).map((name) => [name, READS.has(name) ? 200 : 403]),
);
const ALL_WAIT: Record<string, number> = Object.fromEntries(
	Object.keys(FULL).map((name) => [name, READS.has(name) ? 200 : 202]),
);

describe('every exposed operation', () => {
	let cookie: string;
	let adminId: string;
	let kid: string;
	let adult: string;
	let admin: { secret: string; id: string };
	const fresh = async () => ({ ...(await fixtures(cookie, admin.secret)), adminId });

	beforeEach(async () => {
		({ cookie, adminId } = await setup());
		admin = await addApp(cookie, { roleId: 'admin' });
		kid = await addMember(cookie, 'Kid', 'supervised');
		adult = await addMember(cookie, 'Adult', 'member');
	});

	it.each([
		['admin', FULL],
		['member', FULL],
		// An app is no person: it has no turn at a chore unless its role may edit chores.
		['supervised', { ...SUGGESTS, 'chores.completeChore': 403 }],
		['guest', READS_ONLY],
	])('answers an app with the %s role as that role allows', async (roleId, expected) => {
		const { secret } = await addApp(cookie, { roleId });
		expect(await walk(secret, {}, await fresh())).toEqual(expected);
	});

	it.each([
		['an adult', () => adult, FULL],
		['a child', () => kid, { ...SUGGESTS }],
		['the admin', () => adminId, FULL],
	])('answers an admin app acting for %s as that member allows', async (_who, member, expected) => {
		const id = member();
		const { secret } = await addApp(cookie, { roleId: 'admin', actsFor: [id] });
		expect(await walk(secret, { 'x-familyos-on-behalf-of': id }, await fresh())).toEqual(expected);
	});

	it('holds a member to the app’s role as well as their own', async () => {
		const { secret } = await addApp(cookie, { roleId: 'guest', actsFor: [adminId] });
		expect(await walk(secret, { 'x-familyos-on-behalf-of': adminId }, await fresh())).toEqual(
			READS_ONLY,
		);
	});

	it('waits for approval whatever the role when the app only suggests', async () => {
		const { secret } = await addApp(cookie, { roleId: 'admin', mode: 'suggest' });
		expect(await walk(secret, {}, await fresh())).toEqual(ALL_WAIT);
	});
});

describe('what the API says', () => {
	let cookie: string;
	let admin: string;

	beforeEach(async () => {
		({ cookie } = await setup());
		admin = (await addApp(cookie, { roleId: 'admin' })).secret;
	});

	it('writes instants with an offset and all-day events as days, in the family time zone', async () => {
		await request('POST', '/api/v1/actions/core.updateFamilySettings', {
			cookie,
			body: { timeZone: 'Europe/Istanbul' },
		});
		const timed = await pub(admin, 'POST', '/calendar/events', {
			title: 'Dentist',
			date: '2026-10-21',
			startTime: '09:00',
			endTime: '10:30',
		});
		expect(timed.body).toMatchObject({
			status: 'applied',
			timeZone: 'Europe/Istanbul',
			result: {
				start: '2026-10-21T09:00:00+03:00',
				end: '2026-10-21T10:30:00+03:00',
				date: '2026-10-21',
				startTime: '09:00',
			},
		});
		const allDay = await pub(admin, 'POST', '/calendar/events', {
			title: 'Holiday',
			allDay: true,
			date: '2026-10-26',
			endDate: '2026-10-28',
		});
		expect(allDay.body.result).toMatchObject({
			allDay: true,
			start: '2026-10-26',
			end: '2026-10-28',
		});
		const overnight = await pub(admin, 'POST', '/calendar/events', {
			title: 'Night shift',
			date: '2026-10-21',
			startTime: '22:00',
			endTime: '06:00',
		});
		expect(overnight.body.result).toMatchObject({
			start: '2026-10-21T22:00:00+03:00',
			end: '2026-10-22T06:00:00+03:00',
		});

		const range = await pub(admin, 'GET', '/calendar/occurrences?from=2026-10-20&to=2026-10-30');
		expect(range.body.timeZone).toBe('Europe/Istanbul');
		const byTitle = Object.fromEntries(
			range.body.items.map((o: { title: string }) => [o.title, o]),
		);
		expect(byTitle.Dentist).toMatchObject({
			eventId: timed.body.result.id,
			recurrenceId: '2026-10-21T09:00:00+03:00',
			start: '2026-10-21T09:00:00+03:00',
		});
		expect(byTitle.Holiday).toMatchObject({
			recurrenceId: '2026-10-26',
			start: '2026-10-26',
			end: '2026-10-28',
		});
	});

	it('carries the family time zone in every answer, and typed ids', async () => {
		const answers: Reply[] = [];
		const event = await pub(admin, 'POST', '/calendar/events', {
			title: 'Dentist',
			date: '2026-10-21',
			startTime: '09:00',
		});
		answers.push(event);
		const id = event.body.result.id as string;
		expect(id).toMatch(/^cal_event_[0-9a-f-]{36}$/);
		answers.push(await pub(admin, 'GET', `/calendar/events/${id}`));
		answers.push(await pub(admin, 'GET', '/calendar/occurrences?from=2026-10-20&to=2026-10-30'));
		answers.push(await pub(admin, 'GET', '/lists/tasks'));
		answers.push(await pub(admin, 'GET', '/changes'));
		answers.push(await pub(admin, 'DELETE', `/calendar/events/${id}`));
		answers.push(await pub(admin, 'GET', '/'));
		for (const answer of answers)
			expect(answer.body.timeZone, JSON.stringify(answer.body)).toBe('UTC');
		const task = await pub(admin, 'POST', '/lists/tasks', {
			title: 'Pay',
			dueDate: '2026-10-25',
			dueTime: '17:00',
		});
		expect(task.body.result.id).toMatch(/^task_[0-9a-f-]{36}$/);
		expect(task.body.result.due).toBe('2026-10-25T17:00:00+00:00');
		const undated = await pub(admin, 'POST', '/lists/tasks', { title: 'Whenever' });
		expect(undated.body.result.due).toBeNull();
	});

	it('names the default shopping list in the family language and says it is the default', async () => {
		const made = await request('POST', '/api/v1/actions/lists.createShoppingList', {
			cookie,
			body: { name: 'Hardware' },
		});
		expect(made.body.status).toBe('applied');
		const lists = await pub(admin, 'GET', '/lists/shopping/lists');
		expect(lists.body.items).toEqual([
			expect.objectContaining({ name: 'Groceries', isDefault: true, openCount: 0 }),
			expect.objectContaining({ name: 'Hardware', isDefault: false }),
		]);
		for (const list of lists.body.items) expect(list.id).toMatch(/^shop_list_/);
	});

	it('gives lists as pages of at most the asked size, with a cursor to the next', async () => {
		for (const n of [1, 2, 3, 4, 5])
			await pub(admin, 'POST', '/lists/tasks', { title: `Task ${n}` });
		const first = await pub(admin, 'GET', '/lists/tasks?limit=2');
		expect(first.body.items).toHaveLength(2);
		expect(typeof first.body.next).toBe('string');
		const second = await pub(admin, 'GET', `/lists/tasks?limit=2&cursor=${first.body.next}`);
		const third = await pub(admin, 'GET', `/lists/tasks?limit=2&cursor=${second.body.next}`);
		expect(third.body.items).toHaveLength(1);
		expect(third.body.next).toBeNull();
		const titles = [first, second, third].flatMap((p) =>
			p.body.items.map((t: { title: string }) => t.title),
		);
		expect(new Set(titles).size).toBe(5);
		const everything = await pub(admin, 'GET', '/lists/tasks');
		expect(everything.body.items).toHaveLength(5);
		expect(everything.body.next).toBeNull();
		expect((await pub(admin, 'GET', '/lists/tasks?limit=0')).status).toBe(400);
		expect((await pub(admin, 'GET', '/lists/tasks?limit=501')).status).toBe(400);
		const bad = await pub(admin, 'GET', '/lists/tasks?cursor=nonsense');
		expect(bad.status).toBe(400);
		expect(bad.body.error.fields).toEqual([{ path: 'cursor', message: expect.any(String) }]);
	});

	it('shows a date moved out of a repeating event as that series’ occurrence', async () => {
		const series = await pub(admin, 'POST', '/calendar/events', {
			title: 'Piano',
			date: '2026-10-21',
			startTime: '16:00',
			recurrence: { freq: 'weekly', interval: 1, byDay: ['WE'] },
		});
		const id = series.body.result.id as string;
		const moved = await pub(admin, 'PATCH', `/calendar/events/${id}`, {
			occurrence: '2026-10-28T16:00:00+00:00',
			startTime: '17:00',
		});
		expect(moved.status).toBe(200);
		expect(moved.body.result).toMatchObject({
			seriesId: id,
			start: '2026-10-28T17:00:00+00:00',
			recurrence: null,
			// Where the series had it before, whatever the move.
			seriesRecurrenceId: '2026-10-28T16:00:00+00:00',
		});
		expect(moved.body.result.id).not.toBe(id);
		const range = await pub(admin, 'GET', '/calendar/occurrences?from=2026-10-20&to=2026-11-05');
		const rows = range.body.items.map((o: Record<string, unknown>) => [
			o.eventId,
			o.recurrenceId,
			o.seriesId ?? null,
		]);
		expect(rows).toEqual([
			[id, '2026-10-21T16:00:00+00:00', null],
			[moved.body.result.id, '2026-10-28T17:00:00+00:00', id],
			[id, '2026-11-04T16:00:00+00:00', null],
		]);
		const link = range.body.items[1];
		expect(typeof link.recurrenceKey).toBe('string');
		expect(link.seriesRecurrenceId).toBe('2026-10-28T16:00:00+00:00');
		// Only a moved date has one.
		expect(range.body.items[0]).not.toHaveProperty('seriesRecurrenceId');
		// Deleting one date takes only that date.
		const one = await pub(
			admin,
			'DELETE',
			`/calendar/events/${id}?occurrence=2026-11-04T16:00:00%2B00:00`,
		);
		expect(one.body.result).toEqual({ id, occurrence: '2026-11-04T16:00:00+00:00' });
		// A `+` that a client forgot to encode still names the same instant.
		const plus = await pub(
			admin,
			'DELETE',
			`/calendar/events/${id}?occurrence=2026-10-21T16:00:00+00:00`,
		);
		expect(plus.body.result.occurrence).toBe('2026-10-21T16:00:00+00:00');
		const left = await pub(admin, 'GET', '/calendar/occurrences?from=2026-10-20&to=2026-11-05');
		expect(left.body.items.map((o: { recurrenceId: string }) => o.recurrenceId)).toEqual([
			'2026-10-28T17:00:00+00:00',
		]);
		// Deleting the series takes the dates moved out of it.
		await pub(admin, 'DELETE', `/calendar/events/${id}`);
		const gone = await pub(admin, 'GET', '/calendar/occurrences?from=2026-10-20&to=2026-11-05');
		expect(gone.body.items).toEqual([]);
	});

	it('gives the original day of an all-day date that was moved out of a series', async () => {
		const series = await pub(admin, 'POST', '/calendar/events', {
			title: 'Bin day',
			date: '2026-10-21',
			allDay: true,
			recurrence: { freq: 'weekly', interval: 1, byDay: ['WE'] },
		});
		const id = series.body.result.id as string;
		const moved = await pub(admin, 'PATCH', `/calendar/events/${id}`, {
			occurrence: '2026-10-28',
			date: '2026-10-29',
		});
		expect(moved.status).toBe(200);
		expect(moved.body.result).toMatchObject({
			seriesId: id,
			start: '2026-10-29',
			seriesRecurrenceId: '2026-10-28',
		});
		const range = await pub(admin, 'GET', '/calendar/occurrences?from=2026-10-27&to=2026-10-30');
		expect(range.body.items).toEqual([
			expect.objectContaining({
				recurrenceId: '2026-10-29',
				seriesId: id,
				seriesRecurrenceId: '2026-10-28',
			}),
		]);
	});

	it('shapes a refused request as its own validation errors, not zod’s', async () => {
		const empty = await pub(admin, 'POST', '/calendar/events', {});
		expect(empty.status).toBe(400);
		expect(empty.body.error.code).toBe('bad_request');
		expect(empty.body.error.fields).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: 'title', message: expect.any(String) }),
			]),
		);
		expect(JSON.stringify(empty.body)).not.toMatch(/"errors"|"properties"|"_errors"/);

		const nested = await pub(
			admin,
			'POST',
			`/lists/shopping/lists/${(await pub(admin, 'GET', '/lists/shopping/lists')).body.items[0].id}/items`,
			{
				items: [{ title: '' }],
			},
		);
		expect(nested.body.error.fields).toEqual([
			{ path: 'items[0].title', message: expect.any(String) },
		]);
		const query = await pub(admin, 'GET', '/calendar/occurrences?from=nope&to=2026-10-30');
		expect(query.status).toBe(400);
		expect(query.body.error.fields[0].path).toBe('from');
		const badId = await pub(admin, 'GET', '/calendar/events/not-an-id');
		expect(badId.status).toBe(400);
		expect(badId.body.error.fields[0].path).toBe('eventId');
		const raw = await app.request(`${BASE}/api/public/v1/lists/tasks`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${admin}`,
				'content-type': 'application/json',
				'x-forwarded-for': nextIp(),
			},
			body: '{nope',
		});
		expect(raw.status).toBe(400);
		expect(((await raw.json()) as Reply['body']).error.fields).toEqual([
			{ path: 'body', message: expect.any(String) },
		]);
		const array = await pub(admin, 'POST', '/lists/tasks', [1]);
		expect(array.status).toBe(400);
	});

	it('answers not_found for what is not there, and keeps its codes to a closed list', async () => {
		const missing = await pub(
			admin,
			'GET',
			'/calendar/events/cal_event_00000000-0000-7000-8000-000000000001',
		);
		expect(missing.status).toBe(404);
		expect(missing.body.error.code).toBe('not_found');
		expect((await pub(admin, 'GET', '/nothing/here')).status).toBe(404);
		const codes = [missing, await pub(admin, 'GET', '/calendar/events/x')].map(
			(r) => r.body.error.code,
		);
		const doc = JSON.parse(
			readFileSync(join(import.meta.dirname, '../public-openapi.json'), 'utf8'),
		);
		for (const code of codes) expect(doc.components.schemas.ErrorCode.enum).toContain(code);
	});

	it('never exposes undo data or internal fields', async () => {
		const event = await pub(admin, 'POST', '/calendar/events', {
			title: 'A',
			date: '2026-10-21',
			startTime: '09:00',
		});
		const changed = await pub(admin, 'PATCH', `/calendar/events/${event.body.result.id}`, {
			title: 'B',
		});
		expect(changed.body.result).not.toHaveProperty('before');
		expect(changed.body.result).not.toHaveProperty('split');
		const list = (await pub(admin, 'GET', '/lists/shopping/lists')).body.items[0].id;
		await pub(admin, 'POST', `/lists/shopping/lists/${list}/items`, { items: [{ title: 'Milk' }] });
		const again = await pub(admin, 'POST', `/lists/shopping/lists/${list}/items`, {
			items: [{ title: 'Milk', quantity: '2' }],
		});
		expect(again.body.result).not.toHaveProperty('merged');
		expect(again.body.result.addedIds).toEqual([]);
		const task = await pub(admin, 'POST', '/lists/tasks', { title: 'T' });
		const patched = await pub(admin, 'PATCH', `/lists/tasks/${task.body.result.id}`, {
			notes: 'n',
		});
		expect(patched.body.result).not.toHaveProperty('before');
		expect(patched.body.result.notes).toBe('n');
	});
});

describe('suggestions', () => {
	it('waits as a draft the app can follow to its end, and nobody else can read', async () => {
		const { cookie, adminId } = await setup();
		const suggest = await addApp(cookie, { roleId: 'admin', mode: 'suggest' });
		const other = await addApp(cookie, { roleId: 'admin', mode: 'suggest', name: 'Other' });

		const made = await pub(suggest.secret, 'POST', '/calendar/events', {
			title: 'Dentist',
			date: '2026-10-21',
			startTime: '09:00',
		});
		expect(made.status).toBe(202);
		expect(made.body).toEqual({ status: 'drafted', draftId: expect.any(String), timeZone: 'UTC' });
		const draftId = made.body.draftId as string;

		const waiting = await pub(suggest.secret, 'GET', `/drafts/${draftId}`);
		expect(waiting.status).toBe(200);
		expect(waiting.body).toMatchObject({
			id: draftId,
			status: 'waiting',
			operation: 'calendar.createEvent',
			decidedAt: null,
			timeZone: 'UTC',
		});
		expect(waiting.body).not.toHaveProperty('result');
		// Another app, the admin's own app and an unknown draft all read as "no such suggestion".
		expect((await pub(other.secret, 'GET', `/drafts/${draftId}`)).status).toBe(404);
		expect((await pub(suggest.secret, 'GET', '/drafts/draft_nope')).status).toBe(404);
		const events = await pub(
			suggest.secret,
			'GET',
			'/calendar/occurrences?from=2026-10-20&to=2026-10-30',
		);
		expect(events.body.items).toEqual([]);

		await runtime.kernel.runner.approveDraft(draftId, adminActor(adminId));
		const done = await pub(suggest.secret, 'GET', `/drafts/${draftId}`);
		expect(done.body).toMatchObject({
			status: 'applied',
			error: null,
			result: { title: 'Dentist', start: '2026-10-21T09:00:00+00:00', version: expect.any(Number) },
		});
		expect(done.body.decidedAt).toMatch(/^\d{4}-\d\d-\d\dT.*\+00:00$/);
		const after = await pub(
			suggest.secret,
			'GET',
			'/calendar/occurrences?from=2026-10-20&to=2026-10-30',
		);
		expect(after.body.items).toHaveLength(1);
	});

	it('can be turned down', async () => {
		const { cookie, adminId } = await setup();
		const suggest = await addApp(cookie, { roleId: 'admin', mode: 'suggest' });
		const made = await pub(suggest.secret, 'POST', '/lists/tasks', { title: 'Pay' });
		await runtime.kernel.runner.rejectDraft(made.body.draftId, adminActor(adminId));
		const got = await pub(suggest.secret, 'GET', `/drafts/${made.body.draftId}`);
		expect(got.body).toMatchObject({ status: 'rejected', operation: 'lists.addTask' });
		expect(got.body).not.toHaveProperty('result');
	});

	it('belongs to the member an app acted for, not to the app on its own', async () => {
		const { cookie } = await setup();
		const kid = await addMember(cookie, 'Kid', 'supervised');
		const { secret } = await addApp(cookie, { roleId: 'admin', actsFor: [kid] });
		const made = await pub(
			secret,
			'POST',
			'/calendar/events',
			{ title: 'Party', date: '2026-10-21', startTime: '15:00' },
			{ 'x-familyos-on-behalf-of': kid },
		);
		expect(made.status).toBe(202);
		const id = made.body.draftId as string;
		expect(
			(await pub(secret, 'GET', `/drafts/${id}`, undefined, { 'x-familyos-on-behalf-of': kid }))
				.status,
		).toBe(200);
		expect((await pub(secret, 'GET', `/drafts/${id}`)).status).toBe(404);
		// The child’s own sign-in is another principal too: the draft is not theirs to read here.
		const mine = await runtime.kernel.runner.invoke(
			'calendar.createEvent',
			{ title: 'Mine', date: '2026-10-22', startTime: '10:00' },
			{ kind: 'member', memberId: kid as MemberId, roleId: 'supervised' },
		);
		expect(mine.status).toBe('drafted');
		expect(
			(
				await pub(secret, 'GET', `/drafts/${(mine as { draftId: string }).draftId}`, undefined, {
					'x-familyos-on-behalf-of': kid,
				})
			).status,
		).toBe(404);
	});
});

describe('waiting suggestions', () => {
	const waiting = (secret: string, query = '?status=waiting', onBehalfOf?: string) =>
		pub(
			secret,
			'GET',
			`/drafts${query}`,
			undefined,
			onBehalfOf ? { 'x-familyos-on-behalf-of': onBehalfOf } : {},
		);
	const task = (secret: string, title: string, onBehalfOf?: string) =>
		pub(
			secret,
			'POST',
			'/lists/tasks',
			{ title },
			onBehalfOf ? { 'x-familyos-on-behalf-of': onBehalfOf } : {},
		);

	it('lists what an app alone suggested, with who and what, and never lets it decide', async () => {
		const { cookie, adminId } = await setup();
		const hall = await addApp(cookie, { name: 'Hall script', roleId: 'admin', mode: 'suggest' });
		const other = await addApp(cookie, { name: 'Other', roleId: 'admin', mode: 'suggest' });
		const made = await task(hall.secret, 'Pay the fee');
		expect(made.status).toBe(202);
		await task(other.secret, 'Not mine');

		const list = await waiting(hall.secret);
		expect(list.status).toBe(200);
		expect(list.body).toEqual({
			items: [
				{
					id: made.body.draftId,
					status: 'waiting',
					extension: 'lists',
					title: expect.any(String),
					subject: 'Pay the fee',
					proposedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*\+00:00$/),
					proposedBy: 'Hall script',
					canDecide: false,
				},
			],
			next: null,
			timeZone: 'UTC',
		});
		// Each app sees its own and nothing of the other's.
		expect((await waiting(other.secret)).body.items).toHaveLength(1);

		// A suggestion that was decided no longer waits.
		await runtime.kernel.runner.rejectDraft(made.body.draftId, adminActor(adminId));
		expect((await waiting(hall.secret)).body.items).toEqual([]);
	});

	it('shows an app acting for a member what that member would see', async () => {
		const { cookie, adminId } = await setup();
		const kid = await addMember(cookie, 'Kid', 'supervised');
		const hall = await addApp(cookie, {
			name: 'Hall script',
			roleId: 'admin',
			mode: 'suggest',
			actsFor: [kid, adminId],
		});
		const alone = await task(hall.secret, 'By the app');
		const forKid = await task(hall.secret, 'By the app for Kid', kid);
		// The child asks in the app itself.
		const own = await runtime.kernel.runner.invoke(
			'calendar.createEvent',
			{ title: 'Party', date: '2026-10-21', startTime: '15:00' },
			{ kind: 'member', memberId: kid as MemberId, roleId: 'supervised' },
		);
		expect(own.status).toBe('drafted');
		const ownId = (own as { draftId: string }).draftId;

		const kidSees = await waiting(hall.secret, '?status=waiting', kid);
		expect(kidSees.status).toBe(200);
		const byId = new Map(
			kidSees.body.items.map((item: { id: string }) => [item.id, item] as const),
		);
		expect([...byId.keys()].toSorted()).toEqual([forKid.body.draftId, ownId].toSorted());
		expect(byId.get(forKid.body.draftId)).toMatchObject({
			proposedBy: 'Kid via Hall script',
			canDecide: false,
		});
		expect(byId.get(ownId)).toMatchObject({
			proposedBy: 'Kid',
			extension: 'calendar',
			canDecide: false,
		});

		// The admin may decide all three in the app; through the API they are listed, not decidable.
		const adminSees = await waiting(hall.secret, '?status=waiting', adminId);
		expect(adminSees.body.items).toHaveLength(3);
		for (const item of adminSees.body.items) expect(item.canDecide).toBe(false);
		expect(adminSees.body.items.map((i: { id: string }) => i.id)).toContain(alone.body.draftId);

		// Naming a member the app may not act for is refused as everywhere.
		const stranger = await addMember(cookie, 'Stranger', 'member');
		expect((await waiting(hall.secret, '?status=waiting', stranger)).status).toBe(403);
	});

	it('keeps a member’s suggestions from a member who may not decide them', async () => {
		const { cookie } = await setup();
		const kid = await addMember(cookie, 'Kid', 'supervised');
		const role = await request('POST', '/api/v1/actions/core.createRole', {
			cookie,
			body: { name: 'No deciding', base: 'member', overrides: { 'core.drafts.approve': false } },
		});
		const guest = await addMember(cookie, 'Guest', role.body.output.id);
		const hall = await addApp(cookie, { roleId: 'admin', mode: 'suggest', actsFor: [kid, guest] });
		await runtime.kernel.runner.invoke(
			'calendar.createEvent',
			{ title: 'Party', date: '2026-10-21', startTime: '15:00' },
			{ kind: 'member', memberId: kid as MemberId, roleId: 'supervised' },
		);
		expect((await waiting(hall.secret, '?status=waiting', guest)).body.items).toEqual([]);
		expect((await waiting(hall.secret, '?status=waiting', kid)).body.items).toHaveLength(1);
	});

	it('holds an app to its own role, and asks for the status', async () => {
		const { cookie } = await setup();
		const admin = (await addApp(cookie, { roleId: 'admin' })).secret;
		const role = await request('POST', '/api/v1/actions/core.createRole', {
			cookie,
			body: {
				name: 'No suggestions',
				base: 'member',
				overrides: { 'core.drafts.propose': false },
			},
		});
		const limited = (await addApp(cookie, { roleId: role.body.output.id, name: 'Limited' })).secret;
		const refused = await waiting(limited);
		expect(refused.status).toBe(403);
		expect(refused.body.error).toMatchObject({
			code: 'forbidden',
			capability: 'core.drafts.propose',
		});
		const bad = await waiting(admin, '');
		expect(bad.status).toBe(400);
		expect(bad.body.error.fields).toEqual([expect.objectContaining({ path: 'status' })]);
		expect((await waiting(admin, '?status=applied')).status).toBe(400);
		expect((await waiting(admin, '?status=waiting&limit=0')).status).toBe(400);
		expect((await waiting(admin)).status).toBe(200);
		// A key is needed.
		expect((await request('GET', '/api/public/v1/drafts?status=waiting')).status).toBe(401);
	});

	it('pages like other lists', async () => {
		const { cookie } = await setup();
		const hall = await addApp(cookie, { roleId: 'admin', mode: 'suggest' });
		for (const title of ['One', 'Two', 'Three']) await task(hall.secret, title);
		const first = await waiting(hall.secret, '?status=waiting&limit=2');
		expect(first.body.items.map((i: { subject: string }) => i.subject)).toEqual(['Three', 'Two']);
		expect(first.body.next).toEqual(expect.any(String));
		const second = await waiting(
			hall.secret,
			`?status=waiting&limit=2&cursor=${first.body.next as string}`,
		);
		expect(second.body.items.map((i: { subject: string }) => i.subject)).toEqual(['One']);
		expect(second.body.next).toBeNull();
	});

	it('answers 304 until the waiting list changes, and the log hears of drafts', async () => {
		const { cookie, adminId } = await setup();
		const hall = await addApp(cookie, { roleId: 'admin', mode: 'suggest' });
		const head = await runtime.kernel.changes.head();
		const made = await task(hall.secret, 'Pay');
		expect(await runtime.kernel.changes.head()).toBeGreaterThan(head);

		const first = await waiting(hall.secret);
		const tag = first.headers.get('etag') as string;
		expect(tag).toMatch(/^"[0-9a-f]+"$/);
		const again = (etag: string, query = '?status=waiting') =>
			pub(hall.secret, 'GET', `/drafts${query}`, undefined, { 'if-none-match': etag });
		const same = await again(tag);
		expect(same.status).toBe(304);
		expect(same.body).toBeNull();
		// Another page size is another validator.
		expect((await again(tag, '?status=waiting&limit=1')).status).toBe(200);

		expect((await task(hall.secret, 'Call')).status).toBe(202);
		const more = await again(tag);
		expect(more.status).toBe(200);
		expect(more.headers.get('etag')).not.toBe(tag);

		// A decision in the app moves it on as well.
		await runtime.kernel.runner.rejectDraft(made.body.draftId, adminActor(adminId));
		const decided = await again(more.headers.get('etag') as string);
		expect(decided.status).toBe(200);
		expect(decided.body.items).toHaveLength(1);

		// The change feed names the app's own suggestions by id, and nothing else of core's.
		const feed = await pub(hall.secret, 'GET', `/changes?since=${head}`);
		expect(feed.body.changes).toHaveLength(2);
		expect(feed.body.changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					extension: 'core',
					entity: 'draft',
					id: made.body.draftId,
					op: 'upsert',
				}),
			]),
		);
		for (const change of feed.body.changes)
			expect(Object.keys(change).toSorted()).toEqual([
				'at',
				'entity',
				'extension',
				'id',
				'op',
				'seq',
			]);
	});

	it('tells an app of its own suggestions in the changes feed, and of no other caller’s', async () => {
		const { cookie, adminId } = await setup();
		const kid = await addMember(cookie, 'Kid', 'supervised');
		const mia = await addMember(cookie, 'Mia', 'supervised');
		const hall = await addApp(cookie, {
			name: 'Hall',
			roleId: 'admin',
			mode: 'suggest',
			actsFor: [kid, mia, adminId],
		});
		const other = await addApp(cookie, {
			name: 'Other',
			roleId: 'admin',
			mode: 'suggest',
			actsFor: [kid, mia, adminId],
		});
		const cursorOf = async (secret: string, on?: string) =>
			(await pub(secret, 'GET', '/changes', undefined, on ? { 'x-familyos-on-behalf-of': on } : {}))
				.body.cursor as number;
		const feedOf = async (secret: string, since: number, on?: string) => {
			const res = await pub(
				secret,
				'GET',
				`/changes?since=${since}`,
				undefined,
				on ? { 'x-familyos-on-behalf-of': on } : {},
			);
			expect(res.status).toBe(200);
			return res.body.changes
				.filter((c: { extension: string }) => c.extension === 'core')
				.map((c: { id: string }) => c.id);
		};
		const hallAlone = await cursorOf(hall.secret);
		const otherAlone = await cursorOf(other.secret);
		const hallKid = await cursorOf(hall.secret, kid);
		const hallMia = await cursorOf(hall.secret, mia);
		const hallAdmin = await cursorOf(hall.secret, adminId);

		const ownDraft = (await task(hall.secret, 'Hall alone')).body.draftId as string;
		const kidDraft = (await task(hall.secret, 'Hall for Kid', kid)).body.draftId as string;
		const strangerDraft = (await task(other.secret, 'Other alone')).body.draftId as string;

		// An app alone: its own, never another app's, never a member's.
		expect(await feedOf(hall.secret, hallAlone)).toEqual([ownDraft]);
		expect(await feedOf(other.secret, otherAlone)).toEqual([strangerDraft]);
		// Acting for a member: that member's view, so not another member's.
		expect(await feedOf(hall.secret, hallKid, kid)).toEqual([kidDraft]);
		expect(await feedOf(hall.secret, hallMia, mia)).toEqual([]);
		// An admin may decide every one of them in the app, so acting for the admin shows all.
		expect((await feedOf(hall.secret, hallAdmin, adminId)).toSorted()).toEqual(
			[ownDraft, kidDraft, strangerDraft].toSorted(),
		);

		// A decision is a change of the same suggestion.
		const after = await cursorOf(hall.secret);
		await runtime.kernel.runner.rejectDraft(ownDraft, adminActor(adminId));
		expect(await feedOf(hall.secret, after)).toEqual([ownDraft]);
		expect(await feedOf(other.secret, after)).toEqual([]);
	});
});

describe('validators and conditional writes', () => {
	let cookie: string;
	let admin: string;
	beforeEach(async () => {
		({ cookie } = await setup());
		admin = (await addApp(cookie, { roleId: 'admin' })).secret;
	});

	it('answers a list with an ETag and a repeated read with 304 until something changes', async () => {
		await pub(admin, 'POST', '/lists/tasks', { title: 'Pay' });
		const first = await pub(admin, 'GET', '/lists/tasks');
		const tag = first.headers.get('etag') as string;
		expect(tag).toMatch(/^"[0-9a-f]+"$/);
		const again = await pub(admin, 'GET', '/lists/tasks', undefined, { 'if-none-match': tag });
		expect(again.status).toBe(304);
		expect(again.headers.get('etag')).toBe(tag);
		expect(again.body).toBeNull();
		// Another list, window or page has its own validator.
		const other = await pub(admin, 'GET', '/lists/tasks?limit=1', undefined, {
			'if-none-match': tag,
		});
		expect(other.status).toBe(200);
		// A change by the web app moves it on.
		await request('POST', '/api/v1/actions/lists.addTask', { cookie, body: { title: 'Call' } });
		const changed = await pub(admin, 'GET', '/lists/tasks', undefined, { 'if-none-match': tag });
		expect(changed.status).toBe(200);
		expect(changed.headers.get('etag')).not.toBe(tag);
		expect(changed.body.items).toHaveLength(2);
		// A write through the API moves it on as well.
		await pub(admin, 'POST', '/lists/tasks', { title: 'Another' });
		const latest = await pub(admin, 'GET', '/lists/tasks', undefined, {
			'if-none-match': changed.headers.get('etag') as string,
		});
		expect(latest.status).toBe(200);
	});

	it('keeps validators apart for callers who see different things', async () => {
		const guest = (await addApp(cookie, { roleId: 'guest' })).secret;
		await pub(admin, 'POST', '/lists/tasks', { title: 'Pay' });
		const mine = (await pub(admin, 'GET', '/lists/tasks')).headers.get('etag');
		const theirs = await pub(guest, 'GET', '/lists/tasks', undefined, {
			'if-none-match': mine as string,
		});
		expect(theirs.status).toBe(200);
		expect(theirs.headers.get('etag')).not.toBe(mine);
	});

	it('gives a thing the ETag of its version, and every write the version it leaves', async () => {
		const made = await pub(admin, 'POST', '/lists/tasks', { title: 'Pay' });
		const id = made.body.result.id as string;
		expect(made.headers.get('etag')).toBe('"v0"');
		expect(made.body.result.version).toBe(0);
		const read = await pub(admin, 'GET', `/lists/tasks/${id}`);
		expect(read.headers.get('etag')).toBe('"v0"');
		expect(
			(await pub(admin, 'GET', `/lists/tasks/${id}`, undefined, { 'if-none-match': '"v0"' }))
				.status,
		).toBe(304);
		const patched = await pub(admin, 'PATCH', `/lists/tasks/${id}`, { notes: 'a' });
		const version = patched.body.result.version as number;
		expect(version).toBeGreaterThan(0);
		expect(patched.headers.get('etag')).toBe(`"v${version}"`);
		expect((await pub(admin, 'GET', `/lists/tasks/${id}`)).body.item.version).toBe(version);
		expect(
			(await pub(admin, 'GET', `/lists/tasks/${id}`, undefined, { 'if-none-match': '"v0"' }))
				.status,
		).toBe(200);
	});

	it('refuses a change to something that moved on (412), and a replace that names no version', async () => {
		const made = await pub(admin, 'POST', '/calendar/events', {
			title: 'Dentist',
			date: '2026-10-21',
			startTime: '09:00',
		});
		const id = made.body.result.id as string;
		const whole = {
			event: {
				title: 'Dentist',
				allDay: false,
				date: '2026-10-21',
				endDate: null,
				startTime: '10:00',
				endTime: null,
				memberIds: [],
				location: null,
				notes: null,
				recurrence: null,
				reminder: null,
				tags: null,
			},
		};
		const none = await pub(admin, 'PUT', `/calendar/events/${id}`, whole);
		expect(none.status).toBe(400);
		expect(none.body.error.fields).toEqual([
			{ path: 'header:if-match', message: expect.any(String) },
		]);
		const garbage = await pub(admin, 'PUT', `/calendar/events/${id}`, whole, {
			'if-match': 'banana',
		});
		expect(garbage.status).toBe(400);

		// Someone else changes it first.
		await request('POST', '/api/v1/actions/calendar.changeEvent', {
			cookie,
			body: { id, location: 'Clinic' },
		});
		const stale = await pub(admin, 'PUT', `/calendar/events/${id}`, whole, { 'if-match': '"v0"' });
		expect(stale.status).toBe(412);
		expect(stale.body.error).toMatchObject({
			code: 'precondition_failed',
			currentVersion: expect.any(Number),
		});
		const current = stale.body.error.currentVersion as number;
		const patchStale = await pub(
			admin,
			'PATCH',
			`/calendar/events/${id}`,
			{ notes: 'x' },
			{ 'if-match': '0' },
		);
		expect(patchStale.status).toBe(412);
		// Nothing changed in either case.
		expect((await pub(admin, 'GET', `/calendar/events/${id}`)).body.item).toMatchObject({
			startTime: '09:00',
			notes: null,
		});

		const ok = await pub(admin, 'PUT', `/calendar/events/${id}`, whole, {
			'if-match': `"v${current}"`,
		});
		expect(ok.status).toBe(200);
		expect(ok.body.result).toMatchObject({ startTime: '10:00', location: null });
		expect(ok.headers.get('etag')).toBe(`"v${ok.body.result.version}"`);
		const patched = await pub(
			admin,
			'PATCH',
			`/calendar/events/${id}`,
			{ notes: 'x' },
			{ 'if-match': String(ok.body.result.version) },
		);
		expect(patched.status).toBe(200);
	});

	it('refuses a conditional change of something the operation cannot compare', async () => {
		const made = await pub(admin, 'POST', '/lists/tasks', { title: 'Pay' });
		// A board note has no version-checked operation to change it, and a delete of a task does.
		const stale = await pub(admin, 'DELETE', `/lists/tasks/${made.body.result.id}`, undefined, {
			'if-match': '"v9"',
		});
		expect(stale.status).toBe(412);
		expect((await pub(admin, 'GET', `/lists/tasks/${made.body.result.id}`)).status).toBe(200);
	});
});

describe('repeating a write', () => {
	let cookie: string;
	let admin: string;
	beforeEach(async () => {
		({ cookie } = await setup());
		admin = (await addApp(cookie, { roleId: 'admin' })).secret;
	});

	it('answers a repeated Idempotency-Key with the first answer and does nothing twice', async () => {
		const headers = { 'idempotency-key': 'order-1' };
		const first = await pub(admin, 'POST', '/lists/tasks', { title: 'Pay' }, headers);
		const second = await pub(admin, 'POST', '/lists/tasks', { title: 'Pay' }, headers);
		expect(first.status).toBe(201);
		expect(second.status).toBe(201);
		expect(second.body.result.id).toBe(first.body.result.id);
		expect(first.headers.get('idempotent-replayed')).toBeNull();
		expect(second.headers.get('idempotent-replayed')).toBe('true');
		expect((await pub(admin, 'GET', '/lists/tasks')).body.items).toHaveLength(1);
	});

	it('refuses a key used for another action', async () => {
		const headers = { 'idempotency-key': 'order-2' };
		await pub(admin, 'POST', '/lists/tasks', { title: 'Pay' }, headers);
		const other = await pub(admin, 'POST', '/board/notes', { text: 'Hi' }, headers);
		expect(other.status).toBe(422);
		expect(other.body.error.code).toBe('idempotency_mismatch');
		const bad = await pub(
			admin,
			'POST',
			'/lists/tasks',
			{ title: 'Pay' },
			{ 'idempotency-key': 'no spaces' },
		);
		expect(bad.status).toBe(400);
		expect(bad.body.error.fields[0].path).toBe('header:idempotency-key');
	});

	it('keeps each caller’s keys apart', async () => {
		const kid = await addMember(cookie, 'Kid', 'member');
		const other = (await addApp(cookie, { roleId: 'admin', name: 'Other', actsFor: [kid] })).secret;
		const headers = { 'idempotency-key': 'same' };
		const a = await pub(admin, 'POST', '/lists/tasks', { title: 'A' }, headers);
		const b = await pub(other, 'POST', '/lists/tasks', { title: 'B' }, headers);
		const c = await pub(
			other,
			'POST',
			'/lists/tasks',
			{ title: 'C' },
			{ ...headers, 'x-familyos-on-behalf-of': kid },
		);
		expect(new Set([a.body.result.id, b.body.result.id, c.body.result.id]).size).toBe(3);
		expect(b.headers.get('idempotent-replayed')).toBeNull();
		expect(c.headers.get('idempotent-replayed')).toBeNull();
		expect((await pub(admin, 'GET', '/lists/tasks')).body.items).toHaveLength(3);
	});

	it('does not repeat a suggestion either', async () => {
		const suggest = (await addApp(cookie, { roleId: 'admin', mode: 'suggest', name: 'S' })).secret;
		const headers = { 'idempotency-key': 'draft-1' };
		const first = await pub(suggest, 'POST', '/lists/tasks', { title: 'Pay' }, headers);
		const second = await pub(suggest, 'POST', '/lists/tasks', { title: 'Pay' }, headers);
		expect(second.body.draftId).toBe(first.body.draftId);
		expect(second.headers.get('idempotent-replayed')).toBe('true');
	});
});

describe('the changes feed', () => {
	let cookie: string;
	let admin: string;
	beforeEach(async () => {
		({ cookie } = await setup());
		admin = (await addApp(cookie, { roleId: 'admin' })).secret;
	});

	const asWeb = (action: string, body: unknown) =>
		request('POST', `/api/v1/actions/${action}`, { cookie, body });

	it('gives the current cursor first, then what changed since, by the thing and not the burst', async () => {
		const start = await pub(admin, 'GET', '/changes');
		expect(start.body).toMatchObject({ changes: [], more: false, timeZone: 'UTC' });
		const cursor = start.body.cursor as number;

		// Changes made in the web app appear.
		const made = await asWeb('calendar.createEvent', {
			title: 'Dentist',
			date: '2026-10-21',
			startTime: '09:00',
		});
		const eventId = made.body.output.id as string;
		await asWeb('calendar.changeEvent', { id: eventId, location: 'Clinic' });
		const task = await asWeb('lists.addTask', { title: 'Pay' });
		const first = await pub(admin, 'GET', `/changes?since=${cursor}`);
		expect(first.body.more).toBe(false);
		expect(first.body.changes).toEqual([
			expect.objectContaining({ extension: 'calendar', id: eventId, op: 'upsert' }),
			expect.objectContaining({ extension: 'lists', id: task.body.output.id, op: 'upsert' }),
		]);
		expect(first.body.changes[0].at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);

		// Changes made through the API appear too, and a removal says delete.
		await pub(admin, 'DELETE', `/calendar/events/${eventId}`);
		const next = await pub(admin, 'GET', `/changes?since=${first.body.cursor}`);
		expect(next.body.changes).toEqual([
			expect.objectContaining({ extension: 'calendar', id: eventId, op: 'delete' }),
		]);
		// Asking again from the new cursor finds nothing.
		const quiet = await pub(admin, 'GET', `/changes?since=${next.body.cursor}`);
		expect(quiet.body).toMatchObject({ changes: [], cursor: next.body.cursor });
	});

	it('shows a caller only the changes it may hear of', async () => {
		const role = await asWeb('core.createRole', {
			name: 'No calendar',
			base: 'member',
			overrides: { 'calendar.view': false, 'calendar.edit': false, 'calendar.manage': false },
		});
		const limited = (await addApp(cookie, { roleId: role.body.output.id, name: 'Limited' })).secret;
		const cursor = (await pub(limited, 'GET', '/changes')).body.cursor as number;
		await asWeb('calendar.createEvent', {
			title: 'Secret',
			date: '2026-10-21',
			startTime: '09:00',
		});
		const task = await asWeb('lists.addTask', { title: 'Pay' });
		const heard = await pub(limited, 'GET', `/changes?since=${cursor}`);
		expect(heard.body.changes.map((c: { extension: string }) => c.extension)).toEqual(['lists']);
		expect(heard.body.changes[0].id).toBe(task.body.output.id);
		// The cursor still moves past what it may not hear, so it is not asked for again.
		expect(heard.body.cursor).toBeGreaterThan(cursor + 1);
		const all = await pub(admin, 'GET', `/changes?since=${cursor}`);
		expect(all.body.changes).toHaveLength(2);
		// The role cannot read the calendar either.
		expect(
			(await pub(limited, 'GET', '/calendar/occurrences?from=2026-10-20&to=2026-10-30')).status,
		).toBe(403);
		const found = (await pub(limited, 'GET', '/')).body;
		const names = found.operations.map((o: { name: string }) => o.name);
		expect(names).not.toContain('calendar.listOccurrences');
		expect(names).not.toContain('calendar.getEvent');
		expect(names).toContain('lists.listTasks');
	});

	it('tells a caller to read everything again once the changes it wants are gone (410)', async () => {
		for (const n of [1, 2, 3]) await asWeb('lists.addTask', { title: `Task ${n}` });
		const head = (await pub(admin, 'GET', '/changes')).body.cursor as number;
		expect((await pub(admin, 'GET', `/changes?since=${head - 3}`)).status).toBe(200);
		await runtime.kernel.ctx.db
			.withTables<CoreTables>()
			.deleteFrom('core_changes')
			.where('seq', '<=', head - 1)
			.execute();
		const gone = await pub(admin, 'GET', `/changes?since=0`);
		expect(gone.status).toBe(410);
		expect(gone.body.error.code).toBe('gone');
		// A cursor from the future belongs to another history.
		expect((await pub(admin, 'GET', `/changes?since=${head + 100}`)).status).toBe(410);
		expect((await pub(admin, 'GET', '/changes?since=-1')).status).toBe(400);
		expect((await pub(admin, 'GET', '/changes?since=soon')).status).toBe(400);
	});

	it('leaves out the changes of an extension that is switched off', async () => {
		const cursor = (await pub(admin, 'GET', '/changes')).body.cursor as number;
		await asWeb('lists.addTask', { title: 'Pay' });
		await asWeb('core.setFeatureEnabled', { extensionId: 'lists', enabled: false });
		const heard = await pub(admin, 'GET', `/changes?since=${cursor}`);
		expect(heard.body.changes).toEqual([]);
	});
});

describe('chores and the board', () => {
	it('marks a chore done for the date it was seen on, and takes it back', async () => {
		const { cookie, adminId } = await setup();
		const admin = (await addApp(cookie, { roleId: 'admin' })).secret;
		const created = await request('POST', '/api/v1/actions/chores.createChore', {
			cookie,
			body: {
				title: 'Dishes',
				startDate: '2099-01-01',
				recurrence: { freq: 'daily', interval: 1 },
			},
		});
		const choreId = created.body.output.id as string;
		const list = await pub(admin, 'GET', '/chores');
		expect(list.body.items).toEqual([
			expect.objectContaining({
				id: choreId,
				nextDue: '2099-01-01',
				overdue: expect.any(Boolean),
				version: 0,
			}),
		]);
		expect(list.body.items[0].createdAt).toMatch(/\+00:00$/);

		// An app is nobody, so it says who did it.
		const nobody = await pub(admin, 'POST', `/chores/${choreId}/complete`, {
			dueDate: '2099-01-01',
		});
		expect(nobody.status).toBe(400);
		const done = await pub(admin, 'POST', `/chores/${choreId}/complete`, {
			dueDate: '2099-01-01',
			doneBy: adminId,
		});
		expect(done.status).toBe(200);
		expect(done.body.result.completion).toMatchObject({
			choreId,
			memberId: adminId,
			dueDate: '2099-01-01',
			undoneAt: null,
		});
		expect(done.body.result.chore.nextDue).toBe('2099-01-02');
		// A stale tap changes nothing, and says so.
		const stale = await pub(admin, 'POST', `/chores/${choreId}/complete`, {
			dueDate: '2099-01-01',
			doneBy: adminId,
		});
		expect(stale.body.result).toMatchObject({ completion: null, reason: 'already_done' });

		const detail = await pub(admin, 'GET', `/chores/${choreId}`);
		expect(detail.body.item.history).toEqual([done.body.result.completion]);
		const undone = await pub(
			admin,
			'POST',
			`/chores/completions/${done.body.result.completion.id}/undo`,
		);
		expect(undone.status).toBe(200);
		expect(undone.body.result.nextDue).toBe('2099-01-01');
	});

	it('puts a note on the board and lists it', async () => {
		const { cookie } = await setup();
		const admin = (await addApp(cookie, { roleId: 'admin' })).secret;
		const made = await pub(admin, 'POST', '/board/notes', {
			text: 'Back at six',
			endsOn: '2026-12-01',
		});
		expect(made.status).toBe(201);
		expect(made.body.result).toMatchObject({
			text: 'Back at six',
			pinned: false,
			createdBy: null,
			endsOn: '2026-12-01',
		});
		expect(made.body.result.endsAt).toMatch(/\+00:00$/);
		const list = await pub(admin, 'GET', '/board/notes');
		expect(list.body.items.map((n: { text: string }) => n.text)).toEqual(['Back at six']);
		const refused = await pub(admin, 'POST', '/board/notes', { text: 'x'.repeat(501) });
		expect(refused.status).toBe(400);
	});

	it('writes a member’s note as theirs when an app acts for them', async () => {
		const { cookie } = await setup();
		const leo = await addMember(cookie, 'Leo', 'member');
		const { secret } = await addApp(cookie, { roleId: 'admin', actsFor: [leo] });
		const made = await pub(
			secret,
			'POST',
			'/board/notes',
			{ text: 'From Leo' },
			{ 'x-familyos-on-behalf-of': leo },
		);
		expect(made.body.result.createdBy).toBe(leo);
	});
});

describe('notes an app puts up alone', () => {
	it('are the app’s own: it shows as the author and may change and remove them', async () => {
		const { cookie } = await setup();
		const leo = await addMember(cookie, 'Leo', 'member');
		const home = (await addApp(cookie, { roleId: 'member', name: 'Home Assistant' })).secret;
		const other = (await addApp(cookie, { roleId: 'member', name: 'Other app' })).secret;
		const viaApp = (await addApp(cookie, { roleId: 'member', name: 'Via', actsFor: [leo] })).secret;
		const made = await pub(home, 'POST', '/board/notes', { text: 'Door open' });
		expect(made.status).toBe(201);
		expect(made.body.result).toMatchObject({
			createdBy: null,
			createdByApp: { name: 'Home Assistant' },
		});
		const id = made.body.result.id as string;
		const listed = await pub(home, 'GET', '/board/notes');
		expect(listed.body.items[0].createdByApp).toEqual(made.body.result.createdByApp);

		const edited = await pub(home, 'PATCH', `/board/notes/${id}`, { text: 'Door closed' });
		expect(edited.status).toBe(200);
		expect(edited.body.result.createdByApp.name).toBe('Home Assistant');
		// Another app, and the same app speaking for a member, are not the author.
		expect((await pub(other, 'PATCH', `/board/notes/${id}`, { text: 'no' })).status).toBe(403);
		expect((await pub(other, 'DELETE', `/board/notes/${id}`)).status).toBe(403);
		const forLeo = await pub(
			home,
			'PATCH',
			`/board/notes/${id}`,
			{ text: 'as Leo' },
			{ 'x-familyos-on-behalf-of': leo },
		);
		expect(forLeo.status).toBe(403);
		expect((await pub(home, 'GET', '/board/notes')).body.items[0].text).toBe('Door closed');
		expect((await pub(home, 'DELETE', `/board/notes/${id}`)).body.result).toEqual({
			removed: true,
		});

		// A member's note through an app stays the member's, with no app as author.
		const leos = await pub(
			viaApp,
			'POST',
			'/board/notes',
			{ text: 'From Leo' },
			{ 'x-familyos-on-behalf-of': leo },
		);
		expect(leos.body.result).toMatchObject({ createdBy: leo, createdByApp: null });
		expect(
			(await pub(viaApp, 'PATCH', `/board/notes/${leos.body.result.id}`, { text: 'x' })).status,
		).toBe(403);
	});

	it('keep the name of an app that was revoked', async () => {
		const { cookie } = await setup();
		const home = await addApp(cookie, { roleId: 'member', name: 'Home Assistant' });
		const admin = (await addApp(cookie, { roleId: 'admin' })).secret;
		await pub(home.secret, 'POST', '/board/notes', { text: 'Door open' });
		const revoked = await request('DELETE', `/api/v1/apps/${home.id}`, { cookie });
		expect(revoked.status).toBeLessThan(300);
		const listed = await pub(admin, 'GET', '/board/notes');
		expect(listed.body.items[0].createdByApp).toMatchObject({ name: 'Home Assistant' });
	});
});

describe('changing and removing notes', () => {
	it('edits a note and removes it, for an app that manages the board', async () => {
		const { cookie } = await setup();
		const admin = (await addApp(cookie, { roleId: 'admin' })).secret;
		const made = await pub(admin, 'POST', '/board/notes', { text: 'Back at six' });
		const id = made.body.result.id as string;
		expect(made.headers.get('etag')).toBe('"v0"');

		const edited = await pub(admin, 'PATCH', `/board/notes/${id}`, {
			text: 'Back at seven',
			paper: 'note-3',
			endsOn: '2026-12-01',
		});
		expect(edited.status).toBe(200);
		expect(edited.body.status).toBe('applied');
		expect(edited.body.result).toMatchObject({
			id,
			text: 'Back at seven',
			paper: 'note-3',
			endsOn: '2026-12-01',
			version: 1,
		});
		expect(edited.body.result).not.toHaveProperty('ok');
		expect(edited.body.result.endsAt).toMatch(/\+00:00$/);
		expect(edited.headers.get('etag')).toBe('"v1"');
		// What is left out stays; null lets a note stay.
		const kept = await pub(admin, 'PATCH', `/board/notes/${id}`, { endsOn: null });
		expect(kept.body.result).toMatchObject({ text: 'Back at seven', endsOn: null, endsAt: null });

		const removed = await pub(admin, 'DELETE', `/board/notes/${id}`);
		expect(removed.status).toBe(200);
		expect(removed.body).toEqual({ status: 'applied', result: { removed: true }, timeZone: 'UTC' });
		expect((await pub(admin, 'GET', '/board/notes')).body.items).toEqual([]);
		// Asking again finds it gone; editing says there is no such note.
		expect((await pub(admin, 'DELETE', `/board/notes/${id}`)).body.result).toEqual({
			removed: false,
		});
		expect((await pub(admin, 'PATCH', `/board/notes/${id}`, { text: 'x' })).status).toBe(404);
		expect((await pub(admin, 'PATCH', '/board/notes/board_note_nope', { text: 'x' })).status).toBe(
			400,
		);
	});

	it('changes only a note nobody moved on when If-Match is sent', async () => {
		const { cookie } = await setup();
		const admin = (await addApp(cookie, { roleId: 'admin' })).secret;
		const made = await pub(admin, 'POST', '/board/notes', { text: 'One' });
		const id = made.body.result.id as string;
		await pub(admin, 'PATCH', `/board/notes/${id}`, { text: 'Two' });
		const stale = await pub(
			admin,
			'PATCH',
			`/board/notes/${id}`,
			{ text: 'Three' },
			{ 'if-match': '"v0"' },
		);
		expect(stale.status).toBe(412);
		expect(stale.body.error).toMatchObject({ code: 'precondition_failed', currentVersion: 1 });
		const staleDelete = await pub(admin, 'DELETE', `/board/notes/${id}`, undefined, {
			'if-match': '"v0"',
		});
		expect(staleDelete.status).toBe(412);
		const fresh = await pub(
			admin,
			'PATCH',
			`/board/notes/${id}`,
			{ text: 'Three' },
			{ 'if-match': '"v1"' },
		);
		expect(fresh.status).toBe(200);
		expect(fresh.body.result.text).toBe('Three');
		expect(
			(await pub(admin, 'DELETE', `/board/notes/${id}`, undefined, { 'if-match': '"v2"' })).status,
		).toBe(200);
	});

	it('follows the app’s rules: the author or a manager, and the role', async () => {
		const { cookie } = await setup();
		const leo = await addMember(cookie, 'Leo', 'member');
		const mia = await addMember(cookie, 'Mia', 'member');
		const admin = (await addApp(cookie, { roleId: 'admin', actsFor: [leo, mia] })).secret;
		const plain = (await addApp(cookie, { roleId: 'member', name: 'Plain' })).secret;
		const guest = (await addApp(cookie, { roleId: 'guest', name: 'Guest' })).secret;
		const as = (who: string) => ({ 'x-familyos-on-behalf-of': who });

		const note = await pub(admin, 'POST', '/board/notes', { text: 'Leo’s' }, as(leo));
		const id = note.body.result.id as string;
		// The author, through an app, may change their own note.
		const mine = await pub(admin, 'PATCH', `/board/notes/${id}`, { text: 'Leo’s again' }, as(leo));
		expect(mine.status).toBe(200);
		// Another member, or an app that is nobody and manages nothing, may not.
		const theirs = await pub(admin, 'PATCH', `/board/notes/${id}`, { text: 'Mia’s' }, as(mia));
		expect(theirs.status).toBe(403);
		expect((await pub(admin, 'DELETE', `/board/notes/${id}`, undefined, as(mia))).status).toBe(403);
		expect((await pub(plain, 'PATCH', `/board/notes/${id}`, { text: 'no' })).status).toBe(403);
		expect((await pub(plain, 'DELETE', `/board/notes/${id}`)).status).toBe(403);
		expect((await pub(guest, 'DELETE', `/board/notes/${id}`)).status).toBe(403);
		// The refused ones changed nothing.
		expect((await pub(admin, 'GET', '/board/notes')).body.items[0].text).toBe('Leo’s again');
	});
});

describe('the shopping lists', () => {
	it('adds, ticks, unticks, changes and removes items', async () => {
		const { cookie } = await setup();
		const admin = (await addApp(cookie, { roleId: 'admin' })).secret;
		const listId = (await pub(admin, 'GET', '/lists/shopping/lists')).body.items[0].id as string;
		const added = await pub(admin, 'POST', `/lists/shopping/lists/${listId}/items`, {
			items: [{ title: 'Milk', quantity: '2 l', category: 'dairy' }, { title: 'Bread' }],
		});
		expect(added.status).toBe(201);
		const [milk, bread] = added.body.result.items;
		expect(milk).toMatchObject({
			title: 'Milk',
			quantity: '2 l',
			category: 'dairy',
			done: false,
			doneAt: null,
			listId,
		});
		expect(added.body.result.addedIds).toEqual([milk.id, bread.id]);

		const ticked = await pub(admin, 'POST', `/lists/shopping/items/${milk.id}/complete`);
		expect(ticked.body.result).toMatchObject({ done: true });
		expect(ticked.body.result.doneAt).toMatch(/\+00:00$/);
		const open = await pub(admin, 'GET', `/lists/shopping/lists/${listId}/items`);
		expect(open.body.items.map((i: { title: string; done: boolean }) => [i.title, i.done])).toEqual(
			[
				['Bread', false],
				['Milk', true],
			],
		);
		expect((await pub(admin, 'GET', '/lists/shopping/lists')).body.items[0].openCount).toBe(1);
		const unticked = await pub(admin, 'POST', `/lists/shopping/items/${milk.id}/uncheck`);
		expect(unticked.body.result.done).toBe(false);
		const changed = await pub(admin, 'PATCH', `/lists/shopping/items/${milk.id}`, {
			quantity: '3 l',
		});
		expect(changed.body.result.quantity).toBe('3 l');
		const removed = await pub(admin, 'DELETE', `/lists/shopping/items/${bread.id}`);
		expect(removed.body.result).toEqual({ id: bread.id });
		expect(
			(await pub(admin, 'GET', `/lists/shopping/lists/${listId}/items`)).body.items,
		).toHaveLength(1);

		// An item added again is not repeated, and its version moves with each write.
		const again = await pub(admin, 'POST', `/lists/shopping/lists/${listId}/items`, {
			items: [{ title: 'Milk', quantity: '1 l' }],
		});
		expect(again.body.result.items[0].id).toBe(milk.id);
		expect(again.body.result.addedIds).toEqual([]);
		const fresh = await pub(admin, 'GET', `/lists/shopping/lists/${listId}/items`);
		expect(fresh.body.items[0].version).toBe(again.body.result.items[0].version);
		// An item in a list that does not exist is not found.
		const lost = await pub(
			admin,
			'POST',
			'/lists/shopping/lists/shop_list_00000000-0000-7000-8000-000000000099/items',
			{ items: [{ title: 'X' }] },
		);
		expect(lost.status).toBe(404);
	});
});

describe('adding to the default shopping list', () => {
	it('adds without naming a list, to the list made on install', async () => {
		const { cookie } = await setup();
		const admin = (await addApp(cookie, { roleId: 'admin' })).secret;
		const listId = (await pub(admin, 'GET', '/lists/shopping/lists')).body.items[0].id as string;
		const added = await pub(admin, 'POST', '/lists/shopping/items', {
			items: [{ title: 'Milk', quantity: '2 l' }],
		});
		expect(added.status).toBe(201);
		expect(added.body.result.listId).toBe(listId);
		expect(added.body.result.items[0]).toMatchObject({ title: 'Milk', quantity: '2 l', listId });
		// A list named in the body is not what this operation reads.
		const named = await pub(admin, 'POST', '/lists/shopping/items', {
			listId: 'shop_list_00000000-0000-7000-8000-000000000099',
			items: [{ title: 'Bread' }],
		});
		expect(named.status).toBe(201);
		expect(named.body.result.listId).toBe(listId);
		const items = await pub(admin, 'GET', `/lists/shopping/lists/${listId}/items`);
		expect(items.body.items.map((i: { title: string }) => i.title).toSorted()).toEqual([
			'Bread',
			'Milk',
		]);
	});

	it('suggests when the app only suggests, and refuses a role that may not add', async () => {
		const { cookie } = await setup();
		const suggest = (await addApp(cookie, { roleId: 'admin', mode: 'suggest' })).secret;
		const drafted = await pub(suggest, 'POST', '/lists/shopping/items', {
			items: [{ title: 'Eggs' }],
		});
		expect(drafted.status).toBe(202);
		const guest = (await addApp(cookie, { roleId: 'guest' })).secret;
		const refused = await pub(guest, 'POST', '/lists/shopping/items', {
			items: [{ title: 'Eggs' }],
		});
		expect(refused.status).toBe(403);
	});
});

describe('the calendar range', () => {
	it('refuses a range of more than 62 days, and the document says so', async () => {
		const { cookie } = await setup();
		const admin = (await addApp(cookie, { roleId: 'admin' })).secret;
		const ok = await pub(admin, 'GET', '/calendar/occurrences?from=2026-01-01&to=2026-03-04');
		expect(ok.status).toBe(200);
		const long = await pub(admin, 'GET', '/calendar/occurrences?from=2026-01-01&to=2026-03-05');
		expect(long.status).toBe(400);
		expect(long.body.error.code).toBe('bad_request');
		const committed = JSON.parse(
			readFileSync(join(import.meta.dirname, '../public-openapi.json'), 'utf8'),
		);
		expect(committed.paths['/calendar/occurrences'].get.summary).toContain('62 days');
		expect(readFileSync(join(import.meta.dirname, '../../../docs/guide/api.md'), 'utf8')).toContain(
			'62 days',
		);
	});
});

describe('the public document', () => {
	const committed = JSON.parse(
		readFileSync(join(import.meta.dirname, '../public-openapi.json'), 'utf8'),
	);
	type Operation = {
		operationId: string;
		security?: unknown[];
		responses: Record<
			string,
			{ content?: { 'application/json': { schema: Record<string, unknown> } } }
		>;
	};
	const operations = (): [string, string, Operation][] =>
		Object.entries(committed.paths as Record<string, Record<string, Operation>>).flatMap(
			([path, item]) =>
				Object.entries(item).map(
					([method, op]) => [method, path, op] as [string, string, Operation],
				),
		);

	it('is what the code would generate now', () => {
		const generated = publicOpenApiDocument({
			kernel: runtime.kernel,
			logger: silentLogger,
			appVersion: APP_VERSION,
			clientIp: () => '127.0.0.1',
		});
		expect(JSON.parse(JSON.stringify(generated))).toEqual(committed);
	});

	it('holds every operation extensions offer, and the four of the door itself', () => {
		const offered = runtime.kernel.registry.apiOperations.map(
			(op) => `${op.exposure.method} ${publicPath(op.extension, op.exposure.path)}`,
		);
		const documented = operations().map(([method, path]) => `${method} ${path}`);
		expect(documented.toSorted()).toEqual(
			[...offered, 'get /', 'get /drafts', 'get /drafts/{draftId}', 'get /changes'].toSorted(),
		);
	});

	it('names the waiting suggestions and their page', () => {
		const op = committed.paths['/drafts']?.get;
		expect(op?.operationId).toBe('core.listDrafts');
		expect(committed.components.schemas.DraftSummary).toBeDefined();
		expect(committed.components.schemas.DraftSummaryPage).toBeDefined();
	});

	it('gives every operation one stable name and asks for the bearer key', () => {
		const names = operations().map(([, , op]) => op.operationId);
		expect(new Set(names).size).toBe(names.length);
		for (const name of names) expect(name).toMatch(/^[a-z]+\.[a-z][a-zA-Z]+$/);
		for (const [, path, op] of operations()) expect(op.security, path).toEqual([{ bearer: [] }]);
		expect(committed.components.securitySchemes.bearer).toMatchObject({
			type: 'http',
			scheme: 'bearer',
		});
		expect(committed.servers).toEqual([expect.objectContaining({ url: '/api/public/v1' })]);
	});

	it('names every answer, so a generated client has readable types', () => {
		for (const [method, path, op] of operations()) {
			for (const [status, response] of Object.entries(op.responses)) {
				const schema = response.content?.['application/json'].schema;
				if (!schema) continue;
				expect(schema.$ref, `${method} ${path} ${status}`).toMatch(
					/^#\/components\/schemas\/[A-Z][A-Za-z]+$/,
				);
			}
		}
		const names = Object.keys(committed.components.schemas);
		for (const expected of [
			'Event',
			'Occurrence',
			'Task',
			'ShoppingItem',
			'ShoppingList',
			'Chore',
			'BoardNote',
			'Error',
			'ErrorCode',
			'Drafted',
			'Draft',
			'Changes',
			'Discovery',
		])
			expect(names).toContain(expected);
	});

	it('takes the list of a shopping item from the path, which cannot be left out', () => {
		const named = committed.paths['/lists/shopping/lists/{listId}/items'].post;
		const listId = named.parameters.find((p: { name: string }) => p.name === 'listId');
		expect(listId).toMatchObject({ in: 'path', required: true });
		expect(listId.description).not.toMatch(/omit/i);
		const request = committed.components.schemas.ListsAddShoppingItemsRequest;
		expect(request.properties).not.toHaveProperty('listId');
		// The default list has an address of its own, and no list in it.
		const standard = committed.paths['/lists/shopping/items'].post;
		expect(standard.operationId).toBe('lists.addShoppingItemsDefault');
		expect(standard.parameters.map((p: { in: string }) => p.in)).not.toContain('path');
		expect(
			committed.components.schemas.ListsAddShoppingItemsDefaultRequest.properties,
		).not.toHaveProperty('listId');
	});

	it('describes nested fields for people, in each operation that has them', () => {
		const quantity = (name: string) =>
			committed.components.schemas[name].properties.items.items.properties.quantity.description;
		expect(quantity('ListsAddShoppingItemsRequest')).toBe(
			quantity('ListsAddShoppingItemsDefaultRequest'),
		);
		expect(quantity('ListsAddShoppingItemsRequest')).toContain('a dozen');
		const tags = committed.components.schemas.CalendarReplaceEventRequest.properties.event
			.properties.tags.description as string;
		expect(tags).toContain('at most 5');
	});

	it('gives a chore completion one shape wherever it is named', () => {
		const schemas = committed.components.schemas;
		expect(schemas.ChoreCompletion.required).toContain('undoneAt');
		// A nullable schema is written out in place, with the same fields as the named one.
		const inline = schemas.ChoreCompleted.properties.completion;
		expect(Object.keys(inline.properties)).toEqual(Object.keys(schemas.ChoreCompletion.properties));
		expect(inline.required).toEqual(schemas.ChoreCompletion.required);
		expect(schemas.ChoreDetail.properties.history.items).toEqual({
			$ref: '#/components/schemas/ChoreCompletion',
		});
	});

	it('lists every error code as an enum, and describes the error in our own shape', () => {
		const codes = committed.components.schemas.ErrorCode.enum as string[];
		for (const code of Object.keys(ERROR_HTTP_STATUS)) expect(codes).toContain(code);
		expect(codes).toContain('internal');
		const error = committed.components.schemas.Error.properties.error.properties;
		expect(error.fields.items.required).toEqual(['path', 'message']);
		expect(JSON.stringify(committed)).not.toMatch(/treeify|_errors/);
	});

	it('speaks to programs: no word of the AI tools the actions are also written for', () => {
		const text = JSON.stringify(committed);
		expect(text).not.toMatch(
			/calendar\.find|lists\.shoppingList|lists\.openTasks|lists\.changeTask|calendar\.changeEvent|Required for you|do not call|this tool|, for the AI|reviewer|\bAI\b|\bmodel\b|\btools?\b|instead of inventing|Never a word/,
		);
		// Nothing of the app's own API leaks in.
		expect(text).not.toContain('/api/v1');
		expect(text).not.toContain('session');
	});
});
