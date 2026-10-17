import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FakeBotApi, startFakeBotApi } from '@famos/adapters/telegram/fake-bot-api';
import type { CoreTables } from '@famos/core';
import type { ExtensionDefinition, Logger } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http/app.ts';
import { APP_VERSION, migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { fastPasswordHasher } from './fast-password.ts';
import { discoverSourceExtensions } from './support/extensions.ts';

const extensions = await discoverSourceExtensions();

const BASE = 'http://localhost:3000';
const FAST = {
	pollTimeoutSeconds: 1,
	conflictMs: 50,
	idleMs: 30,
	errorBaseMs: 20,
	errorMaxMs: 50,
};
/** SOI, an EXIF segment holding "GPS", EOI: the Inbox must strip the metadata. */
const PHOTO = Uint8Array.from([
	0xff, 0xd8, 0xff, 0xe1, 0x00, 0x0b, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x47, 0x50, 0x53, 0xff, 0xd9,
]);

let fake: FakeBotApi;
let runtime: Runtime;
let app: ReturnType<typeof createHttpApp>;
let model: { baseUrl: string; answers: object[]; close(): Promise<void> };
let logs: string[];
let responses: string[];
let cookie: string;
let ip = 0;

/** A stand-in OpenAI-compatible server that answers with queued Inbox readings. */
async function startModel() {
	const answers: object[] = [];
	const server = http.createServer((req, res) => {
		req.resume();
		req.on('end', () => {
			res.setHeader('content-type', 'application/json');
			if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fake' }] }));
			const answer = answers.shift() ?? { label: 'Nothing to do', intent: 'nothing', mentions: [] };
			res.end(
				JSON.stringify({
					id: 'fake',
					object: 'chat.completion',
					created: 1,
					model: 'fake',
					choices: [
						{
							index: 0,
							finish_reason: 'stop',
							message: { role: 'assistant', content: JSON.stringify(answer) },
						},
					],
					usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
				}),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
		answers,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

const capturingLogger = (): Logger => {
	const write = (obj: object, msg?: string) => logs.push(JSON.stringify({ obj, msg }));
	const logger: Logger = {
		debug: write,
		info: write,
		warn: write,
		error: write,
		child: (bindings) => {
			logs.push(JSON.stringify(bindings));
			return logger;
		},
	};
	return logger;
};

async function call(method: string, path: string, body?: unknown, withCookie = cookie) {
	const res = await app.request(`${BASE}${path}`, {
		method,
		headers: {
			origin: BASE,
			'x-forwarded-for': `10.2.0.${++ip}`,
			...(body !== undefined && { 'content-type': 'application/json' }),
			...(withCookie && { cookie: withCookie }),
		},
		...(body !== undefined && { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	responses.push(text);
	return {
		status: res.status,
		body: text ? JSON.parse(text) : null,
		cookie: res.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; '),
	};
}

async function until(check: () => boolean | Promise<boolean>, what = 'condition') {
	// A backstop only: a passing run returns as soon as the condition holds, however slow the machine.
	const deadline = Date.now() + 25_000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/** Starts the server with the bot, a model and a family set up; `installed`: its extensions. */
async function start(installed?: readonly ExtensionDefinition[]) {
	logs = [];
	responses = [];
	fake = await startFakeBotApi();
	model = await startModel();
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-telegram-'));
	const config = await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: BASE });
	runtime = openRuntime(config, {
		extensions: installed ?? extensions,
		logger: capturingLogger(),
		quiet: true,
		passwordHasher: fastPasswordHasher,
		telegramApiRoot: fake.url,
		telegramTiming: FAST,
	});
	await migrate(runtime);
	await runtime.kernel.start();
	await runtime.ai.syncFromEnvironment({
		kind: 'openai-compatible',
		name: 'Fake',
		baseUrl: model.baseUrl,
		models: { fast: 'fake', vision: 'fake', smart: 'fake' },
	});
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
		logger: runtime.logger,
		trustedOrigins: [BASE],
		appVersion: APP_VERSION,
		secureCookies: false,
		trustedProxies: ['127.0.0.1'],
	});
	const setup = await call('POST', '/api/v1/core/setup', {
		displayName: 'Parent',
		email: 'parent@example.com',
		password: 'correct horse battery',
		locale: 'en',
		setupCode: runtime.config.setupCode,
	});
	expect(setup.status).toBe(201);
	cookie = (
		await call('POST', '/api/auth/sign-in/email', {
			email: 'parent@example.com',
			password: 'correct horse battery',
		})
	).cookie;
}

async function stop() {
	await runtime.telegram.stop();
	await runtime.close();
	await fake.close();
	await model.close();
}

beforeEach(() => start());
afterEach(async () => {
	vi.useRealTimers();
	await stop();
});

/** Connects the bot and links Telegram user `userId` to `memberId` through the real routes/codes. */
async function link(userId: number, memberId?: string) {
	const { code } = memberId
		? await runtime.telegram.createLinkCode(memberId)
		: (await call('POST', '/api/v1/telegram/link')).body;
	const before = fake.sent().length;
	fake.say(userId, `/start ${code}`);
	await until(() => fake.sent().length > before, 'the link reply');
	return fake.sent()[before]?.text;
}

async function connect() {
	const res = await call('PUT', '/api/v1/telegram/token', { token: fake.token });
	expect(res.status).toBe(200);
	runtime.telegram.start();
	return res;
}

async function addKid() {
	const created = await call('POST', '/api/v1/actions/core.createMember', {
		displayName: 'Kid',
		roleId: 'supervised',
	});
	expect(created.body.status).toBe('applied');
	return created.body.output.id as string;
}

const event = (title: string) => ({ title, allDay: true, date: '2026-12-24' });
const aiActor = { kind: 'ai' as const, mode: 'share' as const, source: 'inbox' };

describe('Telegram settings and linking', () => {
	it('keeps the token secret and lets only admins manage the bot', async () => {
		expect((await call('GET', '/api/v1/telegram/settings', undefined, '')).status).toBe(401);
		const off = await call('GET', '/api/v1/telegram/settings');
		expect(off.body).toMatchObject({ configured: false, state: 'off' });

		const bad = await call('PUT', '/api/v1/telegram/token', {
			token: '999999:wrong-token-ABCDEFGHIJKLMNOPQRSTUV',
		});
		expect(bad.status).toBe(400);

		const res = await connect();
		expect(res.body).toMatchObject({ configured: true, botUsername: 'family_test_bot' });
		await until(
			async () => (await call('GET', '/api/v1/telegram/settings')).body.state === 'ok',
			'the poller to report',
		);

		// A member without the capability cannot read or change anything.
		const kid = await addKid();
		const pin = await call('PUT', `/api/v1/core/members/${kid}/pin`, { pin: '2468' });
		expect(pin.status).toBe(200);
		const device = await call('POST', '/api/v1/core/devices/trust', { name: 'Tablet' });
		const kidCookie = (
			await call('POST', '/api/auth/sign-in/pin', { memberId: kid, pin: '2468' }, device.cookie)
		).cookie;
		expect((await call('GET', '/api/v1/telegram/settings', undefined, kidCookie)).status).toBe(403);
		expect((await call('PUT', '/api/v1/telegram/token', { token: null }, kidCookie)).status).toBe(
			403,
		);
		// …but may link their own account.
		const own = await call('POST', '/api/v1/telegram/link', undefined, kidCookie);
		expect(own.status).toBe(200);
		expect(own.body.url).toBe(`https://t.me/family_test_bot?start=${own.body.code}`);

		expect(responses.join('\n')).not.toContain(fake.token);
		expect(logs.join('\n')).not.toContain(fake.token);
	});

	it('links with a one-time code, shows it to the member, and unlinks', async () => {
		await connect();
		expect((await call('GET', '/api/v1/telegram/link')).body).toMatchObject({
			available: true,
			linked: false,
		});
		expect(await link(55)).toBe(
			'Linked to FamilyOS as Parent. Write to me to ask the assistant; forward messages or send photos and documents to send them to Quick add.',
		);
		expect((await call('GET', '/api/v1/telegram/link')).body).toMatchObject({
			linked: true,
			username: 'user55',
		});
		expect((await call('DELETE', '/api/v1/telegram/link')).status).toBe(200);
		expect((await call('GET', '/api/v1/telegram/link')).body.linked).toBe(false);
	});

	it('unlinks a member who is archived', async () => {
		await connect();
		const kid = await addKid();
		await link(66, kid);
		expect((await runtime.telegram.linkOf(kid)).linked).toBe(true);
		await call('POST', '/api/v1/actions/core.archiveMember', { memberId: kid });
		await until(async () => !(await runtime.telegram.linkOf(kid)).linked, 'the unlink');
		fake.say(66, 'hello?');
		// The poller acknowledges an update only after handling it, so no pending update means the
		// message was handled (and, for an unlinked chat, ignored).
		await until(() => fake.pending() === 0, 'the message to be handled');
		expect(fake.sent().at(-1)?.text).not.toBe('Sent to Quick add.');
	});
});

describe('sharing from Telegram', () => {
	it('turns a photo into an Inbox item that the AI reads, then drafts and approves from Telegram', async () => {
		await connect();
		await link(55);
		const answer = {
			label: 'Christmas Eve dinner',
			intent: 'actionable',
			mentions: [
				{
					kind: 'calendar.event',
					title: 'Christmas Eve dinner',
					date: { text: '24 December', day: 24, month: 12 },
				},
			],
		};
		model.answers.push(answer);
		fake.sendPhoto(55, PHOTO, 'invitation');
		await until(() => fake.sent().some((m) => m.text === 'Sent to Quick add.'), 'the reply');

		const items = (await call('GET', '/api/v1/inbox/items')).body;
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ channel: 'telegram', text: 'invitation', status: 'received' });
		expect(items[0].files).toHaveLength(1);
		const stored = await runtime.kernel.ctx.files.get(`inbox/${items[0].id}/0`);
		const chunks: Uint8Array[] = [];
		for await (const chunk of stored?.stream ?? []) chunks.push(chunk);
		const bytes = Buffer.concat(chunks);
		expect(bytes.includes(Buffer.from('Exif'))).toBe(false); // metadata stripped like an upload

		// The AI pipeline reads it and proposes an event as a draft. It is addressed to the person
		// who shared it, so no approver is told it waits; they get a "ready" message.
		fake.sent().length = 0;
		await runtime.kernel.worker.drain();
		const draftList = (await call('GET', '/api/v1/core/drafts?sourceKind=inbox&limit=10')).body;
		expect(draftList).toHaveLength(1);
		const draftId = draftList[0].id as string;
		expect(draftList[0].status).toBe('pending');
		expect(draftList[0].forMember).not.toBeNull();

		// The sharer is told on Telegram that it is ready, with the draft buttons.
		for (let i = 0; i < 3 && fake.sent().length === 0; i++) await runtime.kernel.worker.drain();
		await until(() => fake.sent().length > 0, 'the notification on Telegram');
		const message = fake.sent()[0];
		expect(message?.chat_id).toBe(55);
		expect(message?.text).toContain('Ready to check');
		const rows = fake.keyboard(0);
		expect(rows[0]?.map((b) => b.callback_data)).toEqual([`a:${draftId}`, `r:${draftId}`]);
		expect(rows[0]?.[0]?.text).toContain('Christmas Eve dinner');

		// Approve from the chat: the draft is applied as that member.
		fake.press(55, 1, `a:${draftId}`, message?.reply_markup);
		await until(
			async () =>
				(await call('GET', '/api/v1/core/drafts?sourceKind=inbox&limit=10')).body[0].status ===
				'applied',
			'the draft to be applied',
		);
		await until(() => fake.callsOf('answerCallbackQuery').length === 1, 'the answer');
		expect(fake.callsOf('answerCallbackQuery')[0]).toMatchObject({ text: 'Approved.' });
		const admin = (await call('GET', '/api/v1/core/me')).body.id;
		const decided = await runtime.kernel.ctx.db
			.withTables<CoreTables>()
			.selectFrom('core_drafts')
			.select('decided_by')
			.where('id', '=', draftId)
			.executeTakeFirstOrThrow();
		expect(decided.decided_by).toBe(admin);
		expect(logs.join('\n')).not.toContain('invitation');
		expect(logs.join('\n')).not.toContain(fake.token);
	});

	it('says an event is already there and moves it from the chat instead of adding a second', async () => {
		await connect();
		await link(55);
		const made = await call('POST', '/api/v1/actions/calendar.createEvent', {
			title: 'Regional Gala',
			date: '2026-11-07',
			startTime: '18:00',
		});
		expect(made.body.status).toBe('applied');
		const galaId = made.body.output.id as string;
		// A model's reading of the coach's message: a new event, not a change.
		model.answers.push({
			label: 'Regional gala moved',
			intent: 'actionable',
			mentions: [
				{
					kind: 'calendar.event',
					title: 'Regional gala',
					date: { text: 'Sat 14 Nov', day: 14, month: 11, weekday: 6 },
					time: '09:00',
					timeText: '09:00',
				},
			],
		});
		fake.say(55, '/paylas Regional gala moved to Sat 14 Nov 09:00');
		await until(() => fake.sent().some((m) => m.text === 'Sent to Quick add.'), 'the reply');
		fake.sent().length = 0;
		for (let i = 0; i < 4 && fake.sent().length === 0; i++) await runtime.kernel.worker.drain();
		await until(() => fake.sent().length > 0, 'the notification on Telegram');
		const draftId = (await call('GET', '/api/v1/core/drafts?sourceKind=inbox&limit=10')).body[0]
			.id as string;

		const message = fake.sent()[0];
		expect(message?.text).toContain('Already on the calendar: Regional Gala · ');
		const rows = fake.keyboard(0);
		expect(rows.slice(0, 2).map((row) => row.map((b) => b.callback_data))).toEqual([
			[`a:${draftId}`, `r:${draftId}`],
			[`m:${draftId}`],
		]);
		expect(rows[1]?.[0]?.text).toMatch(/^↪ Move it to .*14.* instead$/);

		// Moving it: the suggestion becomes the change, still waiting, with its own buttons.
		fake.press(55, 1, `m:${draftId}`, message?.reply_markup);
		await until(() => fake.callsOf('editMessageReplyMarkup').length === 1, 'the new buttons');
		const replaced = (await call('GET', '/api/v1/core/drafts?sourceKind=inbox&limit=10')).body[0];
		expect(replaced).toMatchObject({ actionId: 'calendar.changeEvent', status: 'pending' });
		const edited = fake.callsOf('editMessageReplyMarkup')[0] as {
			reply_markup: { inline_keyboard: { text: string; callback_data?: string }[][] };
		};
		const first = edited.reply_markup.inline_keyboard[0];
		expect(first?.map((b) => b.callback_data)).toEqual([`a:${draftId}`, `r:${draftId}`]);
		expect(first?.[0]?.text).toContain('Change an event');

		// Approving that applies the move: one gala, on the new day.
		fake.press(55, 1, `a:${draftId}`, edited.reply_markup);
		await until(
			async () =>
				(await call('GET', '/api/v1/core/drafts?sourceKind=inbox&limit=10')).body[0].status ===
				'applied',
			'the move to be applied',
		);
		const november = (
			await call('GET', '/api/v1/calendar/occurrences?from=2026-11-01&to=2026-11-30')
		).body as { eventId: string; startDate: string | null; start: number | null }[];
		expect(november).toHaveLength(1);
		expect(november[0]?.eventId).toBe(galaId);
		expect((await call('GET', `/api/v1/calendar/events/${galaId}`)).body).toMatchObject({
			date: '2026-11-14',
			startTime: '09:00',
		});
	});

	it('adds text and links, and says when the Inbox is off', async () => {
		await connect();
		await link(55);
		// Typed text is a question for the assistant; /paylas shares it instead.
		fake.say(55, '/paylas Buy a birthday present for Elif');
		fake.say(55, 'https://example.com/recipe');
		await until(() => fake.sent().filter((m) => m.text === 'Sent to Quick add.').length === 2);
		const items = (await call('GET', '/api/v1/inbox/items')).body as {
			text: string | null;
			url: string | null;
			channel: string;
		}[];
		expect(items.map((i) => i.channel)).toEqual(['telegram', 'telegram']);
		expect(items.map((i) => i.text ?? i.url).sort()).toEqual([
			'Buy a birthday present for Elif',
			'https://example.com/recipe',
		]);

		await call('POST', '/api/v1/actions/core.setFeatureEnabled', {
			extensionId: 'inbox',
			enabled: false,
		});
		fake.say(55, 'one more', {
			forward_origin: { type: 'hidden_user', date: 1, sender_user_name: 'School' },
		});
		await until(() =>
			fake.sent().some((m) => m.text === 'Quick add is turned off, so I cannot add this.'),
		);
	});

	it('sends typed questions to the assistant and its answer back to the chat', async () => {
		await connect();
		await link(55);
		fake.say(55, 'What is on the shopping list?');
		// The test model does not stream, so the turn fails (after one retry) and the chat is told.
		const told = () =>
			fake
				.sent()
				.some((m) => m.text === 'I could not answer that. Please try again, or ask in the app.');
		const deadline = Date.now() + 25_000;
		while (!told() && Date.now() < deadline) {
			await runtime.kernel.worker.drain();
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(told()).toBe(true);
		const threads = (await call('GET', '/api/v1/assistant/threads')).body as { title: string }[];
		expect(threads.map((t) => t.title)).toEqual(['What is on the shopping list?']);
	}, 20_000);

	it('shares typed text to Quick add when no extension answers questions', async () => {
		await stop();
		await start(extensions.filter((e) => e.id !== 'assistant'));
		await connect();
		await link(55);
		fake.say(55, 'Dentist on Friday at 10');
		await until(() => fake.sent().some((m) => m.text === 'Sent to Quick add.'));
		const items = (await call('GET', '/api/v1/inbox/items')).body as {
			text: string | null;
			channel: string;
		}[];
		expect(items.map((i) => [i.channel, i.text])).toEqual([
			['telegram', 'Dentist on Friday at 10'],
		]);
	});

	it('adds voice notes to the Inbox as audio files', async () => {
		await connect();
		await link(55);
		fake.sendVoice(55);
		await until(() => fake.sent().some((m) => m.text === 'Sent to Quick add.'));
		const items = (await call('GET', '/api/v1/inbox/items')).body as {
			channel: string;
			files: { type: string }[];
		}[];
		expect(items).toHaveLength(1);
		expect(items[0]?.channel).toBe('telegram');
		expect(items[0]?.files.map((f) => f.type)).toEqual(['audio/ogg']);
	});
});

describe('deciding from Telegram', () => {
	it('refuses a supervised member politely: capabilities decide', async () => {
		await connect();
		const kid = await addKid();
		await link(66, kid);
		const drafted = await runtime.kernel.runner.invoke(
			'calendar.createEvent',
			event('Party'),
			aiActor,
			{ draft: { sourceKind: 'inbox', sourceId: 'inbox_item_x', summary: 'Party' } },
		);
		expect(drafted.status).toBe('drafted');
		const draftId = (drafted as { draftId: string }).draftId;

		fake.press(66, 1, `a:${draftId}`);
		await until(() => fake.callsOf('answerCallbackQuery').length === 1);
		expect(fake.callsOf('answerCallbackQuery')[0]).toMatchObject({
			text: 'You are not allowed to do this.',
		});
		const list = (await call('GET', '/api/v1/core/drafts?sourceKind=inbox&limit=10')).body;
		expect(list[0].status).toBe('pending');

		// The parent can reject the same draft from their own chat.
		await link(55);
		fake.press(55, 2, `r:${draftId}`);
		await until(
			async () =>
				(await call('GET', '/api/v1/core/drafts?sourceKind=inbox&limit=10')).body[0].status ===
				'rejected',
		);
		await until(() => fake.callsOf('answerCallbackQuery').length === 2, 'the answer');
		expect(fake.callsOf('answerCallbackQuery')[1]).toMatchObject({ text: 'Rejected.' });
	});

	it('ignores strangers pressing buttons', async () => {
		await connect();
		const drafted = await runtime.kernel.runner.invoke(
			'calendar.createEvent',
			event('Party'),
			aiActor,
		);
		const draftId = (drafted as { draftId: string }).draftId;
		fake.press(99, 1, `a:${draftId}`);
		await until(() => fake.callsOf('answerCallbackQuery').length === 1);
		const list = (await call('GET', '/api/v1/core/drafts?limit=10')).body;
		expect(list[0].status).toBe('pending');
	});
});
