import { openDatabase, runMigrations } from '@famos/db';
import { FamosError } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../src/runtime/index.ts';
import { createSecretBox } from '../src/secrets/index.ts';
import { type FakeBotApi, startFakeBotApi } from '../src/telegram/fake-bot-api.ts';
import {
	createTelegram,
	type Telegram,
	type TelegramHandlers,
	type TelegramShare,
	telegramMigrations,
} from '../src/telegram/index.ts';

let fake: FakeBotApi;
let db: ReturnType<typeof openDatabase>['db'];
let now: number;
let shared: TelegramShare[];
let decisions: { memberId: string; draftId: string; verb: string }[];
let decisionError: Error | undefined;
let shareError: Error | undefined;
let drafts: { id: string; label: string }[];
let names: Record<string, string | null>;
const started: Telegram[] = [];

const handlers = (): TelegramHandlers => ({
	async onShare(share) {
		if (shareError) throw shareError;
		shared.push(share);
	},
	async onDecision(decision) {
		if (decisionError) throw decisionError;
		decisions.push(decision);
	},
	async draftButtons() {
		return drafts;
	},
	translate: (_member, key, params) => (params ? `${key} ${JSON.stringify(params)}` : key),
	memberName: async (id) => names[id] ?? null,
});

const make = (overrides: Partial<Parameters<typeof createTelegram>[0]> = {}) => {
	const telegram = createTelegram({
		db,
		box: createSecretBox('s'.repeat(32)),
		clock: { now: () => now },
		logger: silentLogger,
		baseURL: 'https://family.example',
		apiRoot: fake.url,
		pollTimeoutSeconds: 1,
		timing: { conflictMs: 60, idleMs: 30, errorBaseMs: 20, errorMaxMs: 50 },
		...overrides,
	});
	telegram.setHandlers(handlers());
	started.push(telegram);
	return telegram;
};

async function until(check: () => boolean | Promise<boolean>, what = 'condition') {
	// A backstop only: a passing run returns as soon as the condition holds, however slow the machine.
	const deadline = Date.now() + 25_000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/** A connected, running bot with Mom (member mem_1) linked to Telegram user 55. */
async function linked(telegram: Telegram, userId = 55, memberId = 'mem_1') {
	const { code } = await telegram.createLinkCode(memberId);
	const before = fake.sent().length;
	fake.say(userId, `/start ${code}`);
	await until(() => fake.sent().length > before, 'the link reply');
}

beforeEach(async () => {
	fake = await startFakeBotApi();
	({ db } = openDatabase({ path: ':memory:' }));
	await runMigrations(db, [{ scope: 'telegram', migrations: telegramMigrations }]);
	now = Date.UTC(2026, 9, 7, 9);
	shared = [];
	decisions = [];
	decisionError = undefined;
	shareError = undefined;
	drafts = [];
	names = { mem_1: 'Mom', mem_2: 'Dad' };
});
afterEach(async () => {
	for (const t of started.splice(0)) await t.stop();
	await fake.close();
});

describe('connecting a bot', () => {
	it('validates the token, seals it, and never reports it', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		expect(await tg.status()).toMatchObject({
			configured: true,
			botUsername: 'family_test_bot',
			state: 'pending',
		});
		const row = await db
			.withTables<{ telegram_settings: { bot_token: string } }>()
			.selectFrom('telegram_settings')
			.selectAll()
			.executeTakeFirstOrThrow();
		expect(row.bot_token.startsWith('v1.')).toBe(true);
		expect(row.bot_token).not.toContain(fake.token);
		expect(JSON.stringify(await tg.status())).not.toContain(fake.token);
	});

	it('refuses tokens Telegram does not accept', async () => {
		const tg = make();
		await expect(tg.setToken('nonsense')).rejects.toMatchObject({ code: 'bad_request' });
		await expect(tg.setToken('999999:other-token-ABCDEFGHIJKLMNOPQRSTUV')).rejects.toMatchObject({
			code: 'bad_request',
		});
		expect((await tg.status()).configured).toBe(false);
	});

	it('disconnecting or switching to another bot removes the links', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		tg.start();
		await linked(tg);
		expect((await tg.linkOf('mem_1')).linked).toBe(true);
		await tg.setToken(fake.token); // the same bot: links stay
		expect((await tg.linkOf('mem_1')).linked).toBe(true);
		await tg.setToken(null);
		expect(await tg.status()).toMatchObject({ configured: false, state: 'off' });
		expect((await tg.linkOf('mem_1')).linked).toBe(false);
		await expect(tg.createLinkCode('mem_1')).rejects.toMatchObject({ code: 'unavailable' });
	});
});

describe('linking', () => {
	it('links with a valid code, once', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		const code = await tg.createLinkCode('mem_1');
		expect(code.code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
		expect(code.url).toBe(`https://t.me/family_test_bot?start=${code.code}`);
		expect(code.expiresAt).toBe(now + 10 * 60 * 1000);
		tg.start();
		fake.say(55, `/start ${code.code.toLowerCase()}`);
		await until(() => fake.sent().length === 1);
		expect(fake.sent()[0]).toMatchObject({ chat_id: 55 });
		expect(fake.sent()[0]?.text).toBe('telegram_linked {"name":"Mom"}');
		expect(await tg.linkOf('mem_1')).toMatchObject({ linked: true, username: 'user55' });
		expect(await tg.channel.isAvailableFor('mem_1')).toBe(true);
		expect(await tg.channel.isAvailableFor('mem_2')).toBe(false);

		fake.say(66, `/start ${code.code}`); // the code is spent
		await until(() => fake.sent().length === 2);
		expect(fake.sent()[1]?.text).toBe('telegram_code_wrong');
		expect((await tg.linkOf('mem_2')).linked).toBe(false);
	});

	it('answers a wrong or expired code, and a bare /start with a hint', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		tg.start();
		fake.say(55, '/start WRONGCODE');
		await until(() => fake.sent().length === 1);
		expect(fake.sent()[0]?.text).toBe('telegram_code_wrong');

		const { code } = await tg.createLinkCode('mem_1');
		now += 10 * 60 * 1000 + 1;
		fake.say(55, `/start ${code}`);
		await until(() => fake.sent().length === 2);
		expect(fake.sent()[1]?.text).toBe('telegram_code_wrong');
		expect((await tg.linkOf('mem_1')).linked).toBe(false);

		fake.say(55, '/start');
		await until(() => fake.sent().length === 3);
		expect(fake.sent()[2]?.text).toBe('telegram_start_hint');
	});

	it('ignores everything else from people who are not linked', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		tg.start();
		fake.say(77, 'hello bot');
		fake.sendPhoto(77, new Uint8Array([1, 2, 3]));
		fake.sendVoice(77);
		fake.say(77, '/stop');
		await until(() => fake.pending() === 0 && fake.lastOffset() > 1003, 'the updates to be read');
		expect(fake.sent()).toEqual([]);
		expect(shared).toEqual([]);
		expect(fake.callsOf('getFile')).toEqual([]);
	});

	it('/stop unlinks, and an archived member is unlinked on their next message', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		tg.start();
		await linked(tg);
		fake.say(55, '/stop');
		await until(() => fake.sent().length === 2);
		expect(fake.sent()[1]?.text).toBe('telegram_unlinked');
		expect((await tg.linkOf('mem_1')).linked).toBe(false);

		await linked(tg);
		names.mem_1 = null; // archived
		fake.say(55, 'a thought');
		await until(async () => !(await tg.linkOf('mem_1')).linked, 'the link to go');
		expect(shared).toEqual([]);
		expect(await tg.channel.send('mem_1', { title: 't', body: null, url: null, tag: 'n' })).toBe(
			'gone',
		);
	});

	it('moves a link when the same account is claimed by another member', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		tg.start();
		await linked(tg, 55, 'mem_1');
		await linked(tg, 55, 'mem_2');
		expect((await tg.linkOf('mem_1')).linked).toBe(false);
		expect((await tg.linkOf('mem_2')).linked).toBe(true);
	});
});

describe('sharing to the Inbox', () => {
	it('turns text, links, photos and documents into shares', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		tg.start();
		await linked(tg);
		fake.sent().length = 0;

		fake.say(55, 'Dentist on Friday at 3');
		fake.say(55, 'https://example.com/recipe');
		fake.sendPhoto(55, new Uint8Array([9, 8, 7]), 'school letter');
		fake.sendDocument(55, 'invoice.pdf', 'application/pdf', new Uint8Array([1, 2, 3, 4]));
		await until(() => shared.length === 4, 'four shares');

		expect(shared[0]).toMatchObject({
			memberId: 'mem_1',
			text: 'Dentist on Friday at 3',
			files: [],
		});
		expect(shared[1]).toMatchObject({ url: 'https://example.com/recipe' });
		expect(shared[1]?.text).toBeUndefined();
		expect(shared[2]?.text).toBe('school letter');
		expect(shared[2]?.files).toHaveLength(1);
		expect(shared[2]?.files[0]).toMatchObject({ type: 'image/jpeg' });
		// The largest size is downloaded, not the thumbnail.
		expect([...(shared[2]?.files[0]?.bytes ?? [])]).toEqual([9, 8, 7]);
		expect(shared[3]?.files[0]).toMatchObject({ name: 'invoice.pdf', type: 'application/pdf' });
		await until(() => fake.sent().length === 4);
		expect(fake.sent().every((m) => m.text === 'telegram_added')).toBe(true);
	});

	it('adds voice notes as audio files', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		tg.start();
		await linked(tg);
		fake.sent().length = 0;
		fake.sendVoice(55, new Uint8Array([5, 6, 7]));
		await until(() => shared.length === 1, 'the voice note to be shared');
		expect(shared[0]?.files).toHaveLength(1);
		expect(shared[0]?.files[0]).toMatchObject({ type: 'audio/ogg' });
		expect([...(shared[0]?.files[0]?.bytes ?? [])]).toEqual([5, 6, 7]);
		await until(() => fake.sent().length === 1);
		expect(fake.sent()[0]?.text).toBe('telegram_added');
	});

	it('refuses odd file types and big files politely', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		tg.start();
		await linked(tg);
		fake.sent().length = 0;
		fake.sendDocument(55, 'movie.mp4', 'video/mp4', new Uint8Array([1]));
		fake.sendDocument(55, 'huge.pdf', 'application/pdf', new Uint8Array([1]), 21 * 1024 * 1024);
		await until(() => fake.sent().length === 2);
		expect(fake.sent().map((m) => m.text)).toEqual([
			'telegram_file_type_unsupported',
			'telegram_file_too_big',
		]);
		expect(shared).toEqual([]);
	});

	it('tells the person why an item was not added', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		tg.start();
		await linked(tg);
		fake.sent().length = 0;
		shareError = new FamosError('limit_reached', 'Daily upload limit reached');
		fake.say(55, 'one more');
		await until(() => fake.sent().length === 1);
		expect(fake.sent()[0]?.text).toBe('telegram_quota');
		shareError = new FamosError('feature_off', 'inbox is turned off');
		fake.say(55, 'again');
		await until(() => fake.sent().length === 2);
		expect(fake.sent()[1]?.text).toBe('telegram_inbox_off');
	});
});

describe('asking the assistant', () => {
	let asked: { memberId: string; text: string; threadId: string | null }[];
	let busy: boolean;
	const asking = (telegram: Telegram) =>
		telegram.setHandlers({
			...handlers(),
			async onAsk(ask) {
				if (busy) return { status: 'busy' };
				asked.push(ask);
				return { status: 'asked', threadId: 'thread_1', replyId: `reply_${asked.length}` };
			},
		});
	/**
	 * The handler records a question before the service stores the reply it waits for and sends
	 * the typing action, so a question is only fully handled once that action went out.
	 */
	const questionHandled = (count: number, what: string) =>
		until(() => asked.length === count && fake.callsOf('sendChatAction').length === count, what);
	beforeEach(() => {
		asked = [];
		busy = false;
	});

	it('sends typed text to the assistant and forwarded messages, links and the share command to the Inbox', async () => {
		// Command names come from the language packs (here English and one more).
		const tg = make({ vocabulary: () => ['share', 'paylas'] });
		asking(tg);
		await tg.setToken(fake.token);
		tg.start();
		await linked(tg);
		fake.sent().length = 0;

		fake.say(55, 'What is on the shopping list?');
		await questionHandled(1, 'the question');
		expect(asked[0]).toEqual({
			memberId: 'mem_1',
			text: 'What is on the shopping list?',
			threadId: null,
		});
		expect(fake.callsOf('sendChatAction')).toHaveLength(1);

		fake.say(55, 'Parent meeting Thursday 17:00', {
			forward_origin: { type: 'hidden_user', date: 1, sender_user_name: 'School' },
		});
		fake.say(55, 'https://example.com/recipe');
		fake.say(55, '/paylas Buy a gift for Ada');
		await until(() => shared.length === 3, 'three shares');
		expect(shared.map((x) => x.text ?? x.url)).toEqual([
			'Parent meeting Thursday 17:00',
			'https://example.com/recipe',
			'Buy a gift for Ada',
		]);

		// The next question goes to the same thread.
		fake.say(55, 'And the calendar?');
		await questionHandled(2, 'the second question');
		expect(asked[1]?.threadId).toBe('thread_1');
	});

	it('sends the answer only for the reply the chat waits for, with buttons for its drafts', async () => {
		const tg = make();
		asking(tg);
		await tg.setToken(fake.token);
		tg.start();
		await linked(tg);
		fake.say(55, 'Add apples');
		await questionHandled(1, 'the question');
		fake.sent().length = 0;
		drafts = [{ id: 'draft_1', label: 'Apples' }];

		expect(await tg.sendAnswer('mem_1', { replyId: 'other', text: 'x', draftIds: [] })).toBe(false);
		expect(
			await tg.sendAnswer('mem_1', {
				replyId: 'reply_1',
				text: 'I suggested **apples** <3',
				draftIds: ['draft_1'],
			}),
		).toBe(true);
		const [message] = fake.sent();
		expect(message).toMatchObject({ parse_mode: 'HTML', text: 'I suggested <b>apples</b> &lt;3' });
		expect(fake.keyboard(0)[0]?.[0]).toMatchObject({ callback_data: 'a:draft_1' });
		// Sent once: the chat no longer waits.
		expect(await tg.sendAnswer('mem_1', { replyId: 'reply_1', text: 'again', draftIds: [] })).toBe(
			false,
		);
	});

	it('says so while the last answer is still being written', async () => {
		const tg = make();
		asking(tg);
		await tg.setToken(fake.token);
		tg.start();
		await linked(tg);
		fake.sent().length = 0;
		busy = true;
		fake.say(55, 'Anything new?');
		await until(() => fake.sent().length === 1, 'the reply');
		expect(fake.sent()[0]?.text).toBe('telegram_busy');
	});
});

describe('polling', () => {
	it('persists the offset: a restart does not read an update twice', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		tg.start();
		await linked(tg);
		fake.say(55, 'first');
		await until(() => shared.length === 1);
		await tg.stop();
		const row = await db
			.withTables<{ telegram_settings: { update_offset: number } }>()
			.selectFrom('telegram_settings')
			.select('update_offset')
			.executeTakeFirstOrThrow();
		expect(row.update_offset).toBeGreaterThan(1001);

		// A new process: it continues from the stored offset, so Telegram resends nothing.
		const again = make();
		again.start();
		await until(() => fake.callsOf('getUpdates').some((c) => c.offset === row.update_offset));
		fake.say(55, 'second');
		await until(() => shared.length === 2);
		expect(shared.map((s) => s.text)).toEqual(['first', 'second']);
		expect(fake.callsOf('deleteWebhook').length).toBeGreaterThanOrEqual(2);
	});

	it('reports another poller (409), backs off and recovers', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		fake.setConflict(true);
		tg.start();
		await until(async () => (await tg.status()).state === 'conflict', 'conflict state');
		fake.setConflict(false);
		await until(async () => (await tg.status()).state === 'ok', 'recovery');
	});

	it('recovers from network errors', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		fake.failNext('getUpdates', 502, 'Bad Gateway');
		fake.failNext('getUpdates', 429, 'Too Many Requests', { retry_after: 0 });
		tg.start();
		await until(async () => (await tg.status()).state === 'ok', 'ok');
	});

	it('picks up a token saved while it runs, and stops promptly', async () => {
		const tg = make();
		tg.start();
		await new Promise((r) => setTimeout(r, 60));
		expect(fake.callsOf('getUpdates')).toEqual([]);
		await tg.setToken(fake.token);
		await until(() => fake.callsOf('getUpdates').length > 0, 'polling to start');
		// stop() aborts the poll in flight instead of waiting out the long poll; a regression
		// would hang here until the test times out.
		await tg.stop();
	});
});

describe('notifications', () => {
	const message = {
		title: 'Dinner <at> 6',
		body: 'Grandma & friends',
		url: '/calendar',
		tag: 'n1',
	};

	it('sends bold title, escaped text and an Open button', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		tg.start();
		await linked(tg);
		fake.sent().length = 0;
		expect(await tg.channel.send('mem_1', message)).toBe('sent');
		const sent = fake.sent()[0];
		expect(sent).toMatchObject({ chat_id: 55, parse_mode: 'HTML' });
		expect(sent?.text).toBe('<b>Dinner &lt;at&gt; 6</b>\nGrandma &amp; friends');
		expect(sent?.reply_markup).toEqual({
			inline_keyboard: [[{ text: 'telegram_btn_open', url: 'https://family.example/calendar' }]],
		});
	});

	it('puts the link in the text when the address is not https', async () => {
		const tg = make({ baseURL: 'http://192.168.1.5:3000' });
		await tg.setToken(fake.token);
		tg.start();
		await linked(tg);
		fake.sent().length = 0;
		await tg.channel.send('mem_1', message);
		expect(fake.sent()[0]?.text).toContain('http://192.168.1.5:3000/calendar');
		expect(fake.sent()[0]?.reply_markup).toBeUndefined();
	});

	it('falls back to a text link when Telegram refuses the button', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		tg.start();
		await linked(tg);
		fake.sent().length = 0;
		fake.failNext('sendMessage', 400, 'Bad Request: BUTTON_URL_INVALID');
		expect(await tg.channel.send('mem_1', message)).toBe('sent');
		expect(fake.sent()).toHaveLength(1);
		expect(fake.sent()[0]?.text).toContain('https://family.example/calendar');
	});

	it('adds Approve and Reject buttons (at most five drafts, callback data within 64 bytes)', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		tg.start();
		await linked(tg);
		fake.sent().length = 0;
		drafts = Array.from({ length: 7 }, (_, i) => ({
			id: `draft_0193e4a0-7b1c-7d2e-9f3a-${String(i).padStart(12, '0')}`,
			label: `Item ${i} with a rather long summary that must be cut short`,
		}));
		await tg.channel.send('mem_1', { ...message, source: { kind: 'inbox', id: 'inbox_item_1' } });
		const keyboard = fake.keyboard(0);
		expect(keyboard).toHaveLength(6); // five draft rows and the Open row
		for (const row of keyboard.slice(0, 5)) {
			expect(row).toHaveLength(2);
			expect(row[0]?.callback_data).toMatch(/^a:draft_/);
			expect(row[1]?.callback_data).toMatch(/^r:draft_/);
			for (const button of row)
				expect(Buffer.byteLength(button.callback_data ?? '')).toBeLessThanOrEqual(64);
			expect(row[0]?.text.length).toBeLessThanOrEqual(30);
		}
	});

	it('leaves out a draft whose id cannot fit into callback data', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		tg.start();
		await linked(tg);
		fake.sent().length = 0;
		drafts = [{ id: `draft_${'x'.repeat(80)}`, label: 'Too long' }];
		await tg.channel.send('mem_1', { ...message, source: { kind: 'inbox', id: 'i' } });
		const rows = fake.keyboard(0);
		expect(rows).toHaveLength(1); // only Open
	});

	it('unlinks and reports gone when the person blocked the bot', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		tg.start();
		await linked(tg);
		fake.failNext('sendMessage', 403, 'Forbidden: bot was blocked by the user');
		expect(await tg.channel.send('mem_1', message)).toBe('gone');
		expect((await tg.linkOf('mem_1')).linked).toBe(false);
		expect(await tg.channel.send('mem_1', message)).toBe('gone');
	});

	it('throws on rate limits and outages so the job is retried', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		tg.start();
		await linked(tg);
		fake.failNext('sendMessage', 429, 'Too Many Requests: retry after 3', { retry_after: 3 });
		await expect(tg.channel.send('mem_1', message)).rejects.toThrow(/429/);
		expect((await tg.linkOf('mem_1')).linked).toBe(true);
	});
});

describe('button presses', () => {
	const keyboard = {
		inline_keyboard: [
			[
				{ text: '✓ A', callback_data: 'a:draft_1' },
				{ text: '✗', callback_data: 'r:draft_1' },
			],
			[
				{ text: '✓ B', callback_data: 'a:draft_2' },
				{ text: '✗', callback_data: 'r:draft_2' },
			],
		],
	};

	it('approves and rejects as the linked member, answers, and drops that draft’s buttons', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		tg.start();
		await linked(tg);
		fake.press(55, 7, 'a:draft_1', keyboard);
		await until(() => fake.callsOf('editMessageReplyMarkup').length === 1);
		expect(decisions).toEqual([{ memberId: 'mem_1', draftId: 'draft_1', verb: 'approve' }]);
		expect(fake.callsOf('answerCallbackQuery')[0]).toMatchObject({ text: 'telegram_approved' });
		expect(fake.callsOf('editMessageReplyMarkup')[0]).toMatchObject({
			chat_id: 55,
			message_id: 7,
			reply_markup: { inline_keyboard: [keyboard.inline_keyboard[1]] },
		});

		fake.press(55, 7, 'r:draft_2', keyboard);
		await until(() => decisions.length === 2);
		expect(decisions[1]).toEqual({ memberId: 'mem_1', draftId: 'draft_2', verb: 'reject' });
		expect(fake.callsOf('answerCallbackQuery')[1]).toMatchObject({ text: 'telegram_rejected' });
	});

	it('says so when the member may not decide, and keeps the buttons', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		tg.start();
		await linked(tg);
		decisionError = new FamosError('forbidden', 'Not allowed');
		fake.press(55, 7, 'a:draft_1', keyboard);
		await until(() => fake.callsOf('answerCallbackQuery').length === 1);
		expect(fake.callsOf('answerCallbackQuery')[0]).toMatchObject({ text: 'telegram_not_allowed' });
		expect(fake.callsOf('editMessageReplyMarkup')).toEqual([]);
	});

	it('answers a draft that was decided elsewhere and removes its buttons', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		tg.start();
		await linked(tg);
		decisionError = new FamosError('conflict', 'Draft is rejected');
		fake.press(55, 7, 'a:draft_1', keyboard);
		await until(() => fake.callsOf('editMessageReplyMarkup').length === 1);
		expect(fake.callsOf('answerCallbackQuery')[0]).toMatchObject({
			text: 'telegram_already_decided',
		});
	});

	it('ignores presses from people who are not linked', async () => {
		const tg = make();
		await tg.setToken(fake.token);
		tg.start();
		fake.press(99, 7, 'a:draft_1', keyboard);
		await until(() => fake.callsOf('answerCallbackQuery').length === 1);
		expect(decisions).toEqual([]);
		expect(fake.callsOf('answerCallbackQuery')[0]?.text).toBeUndefined();
	});
});
