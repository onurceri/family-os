import { defineNotificationKind, systemActor } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notificationCreated } from '../src/core-events.ts';
import { absoluteLink, quietUntil } from '../src/notifications.ts';
import { buildRegistry } from '../src/registry.ts';
import { notesExtension } from './fixtures.ts';
import {
	createTestKernel,
	defineTestExtension,
	type FakeChannel,
	fakeChannel,
	type TestKernel,
} from './harness.ts';

let k: TestKernel;
let web: FakeChannel;
let tg: FakeChannel;
beforeEach(async () => {
	web = fakeChannel('webpush');
	tg = fakeChannel('telegram');
	k = await createTestKernel({
		extensions: [notesExtension],
		channels: [web, tg],
		// Shows which locale and parameters a text was rendered with.
		translate: (locale, key, params) => `${locale}|${key}|${params?.what ?? ''}`,
	});
});
afterEach(() => k.close());

const rows = () =>
	k.ctx.db
		.withTables<import('../src/tables.ts').CoreTables>()
		.selectFrom('core_notifications')
		.selectAll()
		.orderBy('created_at')
		.execute();
const ids = (list: { member_id: string }[]) => list.map((r) => r.member_id).sort();
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const setPrefs = (actor: Parameters<TestKernel['runner']['invoke']>[2], prefs: object) =>
	k.runner.invoke('core.setNotificationPreferences', prefs, actor);

describe('recipients', () => {
	it('resolves a capability to active members, leaving out `except`', async () => {
		const a = await k.member('admin');
		const b = await k.member('member');
		await k.member('supervised'); // cannot approve
		const d = await k.member('member');
		await k.runner.invoke('core.archiveMember', { memberId: d.member.id }, a.actor);
		const created: string[] = [];
		k.bus.on(notificationCreated, ({ memberId }) => void created.push(memberId));

		await k.ctx.notify({
			kind: 'notes.announced',
			to: { capability: 'core.drafts.approve', except: a.member.id },
			title: { key: 'app:x' },
		});
		await k.worker.drain();

		expect(ids(await rows())).toEqual([b.member.id]);
		expect(created).toEqual([b.member.id]);
	});

	it('adds explicit members to the capability holders, skipping archived ones', async () => {
		const a = await k.member('admin');
		const s = await k.member('supervised');
		const gone = await k.member('guest');
		await k.runner.invoke('core.archiveMember', { memberId: gone.member.id }, a.actor);
		await k.ctx.notify({
			kind: 'notes.announced',
			to: { members: [s.member.id, gone.member.id], capability: 'core.drafts.approve' },
			title: { key: 'app:x' },
		});
		await k.worker.drain();
		expect(ids(await rows())).toEqual([a.member.id, s.member.id].sort());
	});

	it('refuses unknown kinds and capabilities', async () => {
		await expect(
			k.ctx.notify({ kind: 'notes.nope', to: { members: [] }, title: { key: 'app:x' } }),
		).rejects.toThrow(/Unknown notification kind/);
		await expect(
			k.ctx.notify({
				kind: 'notes.announced',
				to: { capability: 'notes.nope' },
				title: { key: 'app:x' },
			}),
		).rejects.toThrow(/unknown capability/);
	});

	it('enqueues from an action in its transaction: a rollback sends nothing', async () => {
		const a = await k.member('admin');
		const request = {
			kind: 'notes.announced',
			to: { members: [a.member.id] },
			title: { key: 'app:x' },
		};
		await expect(
			k.runner.invoke('notes.announce', { request, fail: true }, a.actor),
		).rejects.toThrow();
		expect(await k.worker.drain()).toBe(0);
		await k.runner.invoke('notes.announce', { request }, a.actor);
		await k.worker.drain();
		expect(await rows()).toHaveLength(1);
	});
});

describe('collapsing repeats', () => {
	const request = (memberId: string) => ({
		kind: 'notes.announced',
		to: { members: [memberId] },
		title: { key: 'app:x' },
		dedupeKey: 'same',
	});

	it('makes one notification from repeats, before and after the first one ran', async () => {
		const a = await k.member('admin');
		await k.ctx.notify(request(a.member.id));
		await k.ctx.notify(request(a.member.id));
		await k.worker.drain();
		expect(web.sent).toHaveLength(1);
		await k.ctx.notify(request(a.member.id));
		await k.worker.drain();
		expect(await rows()).toHaveLength(1);
	});

	it('does not duplicate rows when a job runs again (retry)', async () => {
		const a = await k.member('admin');
		const b = await k.member('member');
		const payload = {
			id: 'notify_retry',
			kind: 'notes.announced',
			to: { members: [a.member.id, b.member.id] },
			title: { key: 'app:x' },
		};
		await k.queue.enqueue(k.ctx.db, 'core.notify', payload);
		await k.queue.enqueue(k.ctx.db, 'core.notify', payload);
		await k.worker.drain();
		expect(await rows()).toHaveLength(2);
		expect(web.sent).toHaveLength(2);
	});
});

describe('delivery', () => {
	it('sends the rendered text to every available channel the kind enables', async () => {
		const a = await k.member('admin');
		await k.ctx.notify({
			kind: 'notes.announced',
			to: { members: [a.member.id] },
			title: { key: 'app:title' },
			body: { key: 'app:body', params: { what: 'Soup' } },
			url: '/add',
		});
		await k.worker.drain();
		const [row] = await rows();
		for (const channel of [web, tg]) {
			expect(channel.sent).toEqual([
				{ memberId: a.member.id, title: 'en|app:title|', body: 'en|app:body|Soup', url: '/add' },
			]);
		}
		expect(row?.id).toMatch(/^notification_/);
	});

	it('follows kind defaults, member choices and availability', async () => {
		const a = await k.member('admin');
		const b = await k.member('member');
		tg.available = [a.member.id]; // b has not linked Telegram
		await setPrefs(b.actor, { kinds: { 'notes.quiet': { webpush: true } }, quietHours: null });
		await k.ctx.notify({
			kind: 'notes.quiet', // Telegram only, by default
			to: { members: [a.member.id, b.member.id] },
			title: { key: 'app:x' },
		});
		await k.worker.drain();
		expect(tg.sent.map((s) => s.memberId)).toEqual([a.member.id]);
		expect(web.sent.map((s) => s.memberId)).toEqual([b.member.id]);

		// Switching a default-on channel off.
		await setPrefs(a.actor, { kinds: { 'notes.announced': { webpush: false } }, quietHours: null });
		web.sent.length = 0;
		await k.ctx.notify({
			kind: 'notes.announced',
			to: { members: [a.member.id] },
			title: { key: 'app:y' },
		});
		await k.worker.drain();
		expect(web.sent).toEqual([]);
		expect(await rows()).toHaveLength(3); // the in-app record is always written
	});

	it('renders in the member language, else the family language', async () => {
		const a = await k.member('admin');
		const b = await k.member('member');
		await k.runner.invoke('core.updateMember', { memberId: b.member.id, locale: 'tr' }, a.actor);
		await k.ctx.notify({
			kind: 'notes.announced',
			to: { members: [a.member.id, b.member.id] },
			title: { key: 'app:t' },
		});
		await k.worker.drain();
		expect(web.sent.map((s) => s.title).sort()).toEqual(['en|app:t|', 'tr|app:t|']);
		const list = await k.route('core.listNotifications').call({ actor: b.actor });
		expect(list.items[0].title).toBe('tr|app:t|');
	});

	it("writes dates and times out for each reader: their words, the family's region and clock", async () => {
		const a = await k.member('admin');
		const b = await k.member('member');
		await k.runner.invoke('core.updateMember', { memberId: b.member.id, locale: 'tr' }, a.actor);
		await k.runner.invoke(
			'core.updateFamilySettings',
			{ formatLocale: 'sl-SI', hourCycle: 'h12', timeZone: 'Europe/Ljubljana' },
			a.actor,
		);
		const instant = Date.UTC(2026, 9, 22, 15, 5); // 17:05 in Ljubljana
		await k.ctx.notify({
			kind: 'notes.announced',
			to: { members: [a.member.id, b.member.id] },
			title: { key: 'app:t', params: { what: { date: '2026-10-22' } } },
			body: { key: 'app:b', params: { what: { at: instant } } },
		});
		await k.ctx.notify({
			kind: 'notes.announced',
			to: { members: [a.member.id] },
			title: { key: 'app:u', params: { what: { time: '09:30' } } },
			body: { key: 'app:v', params: { what: { at: instant, timeZone: 'UTC' } } },
		});
		await k.worker.drain();
		const norm = (text: string | null | undefined) => text?.replace(/[  ]/g, ' ');
		const shown = web.sent.map((s) => `${norm(s.title)} / ${norm(s.body)}`).sort();
		expect(shown).toEqual([
			'en|app:t|22 Oct 2026 / en|app:b|5:05 pm',
			'en|app:u|9:30 am / en|app:v|3:05 pm',
			'tr|app:t|22 Eki 2026 / tr|app:b|ÖS 5:05',
		]);
		const list = await k.route('core.listNotifications').call({ actor: b.actor });
		expect(norm(list.items[0].title)).toBe('tr|app:t|22 Eki 2026');
	});

	it("treats 'gone' as final and retries a thrown error", async () => {
		const a = await k.member('admin');
		tg.available = false;
		web.next('gone');
		await k.ctx.notify({
			kind: 'notes.announced',
			to: { members: [a.member.id] },
			title: { key: 'app:x' },
		});
		await k.worker.drain();
		k.clock.advance(HOUR);
		expect(await k.worker.drain()).toBe(0);
		expect(web.attempts).toBe(1);

		web.next(new Error('network'));
		await k.ctx.notify({
			kind: 'notes.announced',
			to: { members: [a.member.id] },
			title: { key: 'app:y' },
		});
		await k.worker.drain();
		expect(web.attempts).toBe(2);
		k.clock.advance(10_000);
		await k.worker.drain();
		expect(web.attempts).toBe(3);
		expect(web.sent.map((s) => s.title)).toEqual(['en|app:x|', 'en|app:y|']); // the first was 'gone'
	});

	it('does not push what was already read in the app', async () => {
		const a = await k.member('admin');
		await setPrefs(a.actor, { kinds: {}, quietHours: { start: '10:00', end: '11:00' } });
		k.clock.advance(HOUR + 1000); // 10:00:01, inside quiet hours
		await k.ctx.notify({
			kind: 'notes.announced',
			to: { members: [a.member.id] },
			title: { key: 'app:y' },
		});
		await k.worker.drain();
		await k.runner.invoke('core.markNotificationsRead', {}, a.actor);
		k.clock.advance(HOUR);
		await k.worker.drain();
		expect(web.sent).toEqual([]);
	});

	it('drops a waiting delivery when the feature or the channel is turned off meanwhile', async () => {
		const a = await k.member('admin');
		await setPrefs(a.actor, { kinds: {}, quietHours: { start: '10:00', end: '11:00' } });
		k.clock.advance(HOUR + 1000); // inside quiet hours: deliveries wait
		const send = () =>
			k.ctx.notify({
				kind: 'notes.announced',
				to: { members: [a.member.id] },
				title: { key: 'app:z' },
			});
		await send();
		await k.worker.drain();
		await setPrefs(a.actor, {
			kinds: { 'notes.announced': { webpush: false } },
			quietHours: { start: '10:00', end: '11:00' },
		});
		await k.runner.invoke(
			'core.setFeatureEnabled',
			{ extensionId: 'notes', enabled: false },
			a.actor,
		);
		k.clock.advance(HOUR);
		await k.worker.drain();
		await k.runner.invoke(
			'core.setFeatureEnabled',
			{ extensionId: 'notes', enabled: true },
			a.actor,
		);
		await k.worker.drain();
		expect(web.sent).toEqual([]);
		expect(tg.sent).toEqual([]);
	});

	it('does not tell about a turned-off extension', async () => {
		const a = await k.member('admin');
		await k.runner.invoke(
			'core.setFeatureEnabled',
			{ extensionId: 'notes', enabled: false },
			a.actor,
		);
		await k.ctx.notify({
			kind: 'notes.announced',
			to: { members: [a.member.id] },
			title: { key: 'app:x' },
		});
		await k.worker.drain();
		expect(await rows()).toEqual([]);
		const prefs = await k.route('core.getNotificationPreferences').call({ actor: a.actor });
		expect(prefs.kinds.map((x: { id: string }) => x.id)).toEqual([
			'core.draftWaiting',
			'core.draftDecided',
			'core.backupFailed',
			'core.backupRestored',
			'core.aiAppConnected',
			'core.aiAppDisconnected',
			'core.autoApprovalStopped',
		]);
	});
});

describe('quiet hours', () => {
	it('waits for the end of a window that crosses midnight', async () => {
		const a = await k.member('admin');
		await setPrefs(a.actor, { kinds: {}, quietHours: { start: '22:00', end: '07:00' } });
		k.clock.advance(14 * HOUR); // 23:00
		await k.ctx.notify({
			kind: 'notes.announced',
			to: { members: [a.member.id] },
			title: { key: 'app:x' },
		});
		await k.worker.drain();
		expect(await rows()).toHaveLength(1); // the in-app row is written at once
		expect(web.sent).toEqual([]);
		k.clock.advance(7 * HOUR); // 06:00
		await k.worker.drain();
		expect(web.sent).toEqual([]);
		k.clock.advance(HOUR); // 07:00
		await k.worker.drain();
		expect(web.sent).toHaveLength(1);
		expect(tg.sent).toHaveLength(1);
		// And it is delivered once, however often the queue is looked at.
		k.clock.advance(DAY);
		await k.worker.drain();
		expect(web.sent).toHaveLength(1);
	});

	it('computes the end of a same-day and an early-morning window', () => {
		const at = (h: number, m = 0) => Date.UTC(2026, 0, 1, h, m);
		expect(quietUntil(null, at(1), 'UTC')).toBeNull();
		const day = { start: '12:00', end: '13:00' };
		expect(quietUntil(day, at(11, 59), 'UTC')).toBeNull();
		expect(quietUntil(day, at(12), 'UTC')).toBe(at(13));
		expect(quietUntil(day, at(13), 'UTC')).toBeNull();
		const night = { start: '22:00', end: '07:00' };
		expect(quietUntil(night, at(23), 'UTC')).toBe(at(31)); // 07:00 the next day
		expect(quietUntil(night, at(3), 'UTC')).toBe(at(7));
		expect(quietUntil(night, at(12), 'UTC')).toBeNull();
		// The family's time zone decides: 23:00 UTC is 02:00 in Istanbul (UTC+3).
		expect(quietUntil(night, at(23), 'Europe/Istanbul')).toBe(at(28));
	});
});

describe('draft waiting', () => {
	it('tells approvers once, after a short wait, and not the proposer', async () => {
		const admin = await k.member('admin');
		const member = await k.member('member');
		await k.member('supervised');
		const ai = { kind: 'ai' as const, mode: 'share' as const, source: 'inbox' };
		const meta = { draft: { sourceKind: 'inbox', sourceId: 'inbox_item_1', summary: 'Dentist' } };
		await k.runner.invoke('notes.addNote', { body: 'a' }, ai, meta);
		await k.runner.invoke('notes.addNote', { body: 'b' }, ai, meta);
		await k.worker.drain();
		expect(await rows()).toEqual([]); // waiting for more drafts of the same item
		k.clock.advance(30_000);
		await k.worker.drain();
		const made = await rows();
		expect(ids(made)).toEqual([admin.member.id, member.member.id].sort());
		expect(made[0]).toMatchObject({
			kind: 'core.draftWaiting',
			url: '/add',
			source_kind: 'inbox',
			source_id: 'inbox_item_1',
		});
		const list = await k.route('core.listNotifications').call({ actor: member.actor });
		expect(list.items[0]).toMatchObject({
			title: 'en|app:notify_draft_waiting_title|',
			body: 'en|app:notify_draft_waiting_body|Dentist',
		});
	});

	it("passes the notification's source on to the channels", async () => {
		const admin = await k.member('admin');
		const ai = { kind: 'ai' as const, mode: 'share' as const, source: 'inbox' };
		const meta = { draft: { sourceKind: 'inbox', sourceId: 'inbox_item_1', summary: 'Dentist' } };
		await k.runner.invoke('notes.addNote', { body: 'a' }, ai, meta);
		k.clock.advance(30_000);
		await k.worker.drain();
		expect(web.sent).toHaveLength(1);
		expect(web.sent[0]).toMatchObject({
			memberId: admin.member.id,
			source: { kind: 'inbox', id: 'inbox_item_1' },
		});
		// A notification without a source carries none.
		await k.ctx.notify({
			kind: 'notes.announced',
			to: { members: [admin.member.id] },
			title: { key: 'app:plain' },
		});
		await k.worker.drain();
		expect(web.sent.at(-1)?.source).toBeUndefined();
	});

	it('leaves out a member who proposes, and falls back to the action title', async () => {
		const admin = await k.member('admin');
		const member = await k.member('member');
		// "Purge notes" always needs approval, even for an admin.
		const result = await k.runner.invoke('notes.purge', {}, admin.actor);
		expect(result.status).toBe('drafted');
		k.clock.advance(30_000);
		await k.worker.drain();
		const made = await rows();
		expect(ids(made)).toEqual([member.member.id]);
		expect(made[0]?.source_kind).toBe('draft');
		const list = await k.route('core.listNotifications').call({ actor: member.actor });
		// The approvers read who asked for it.
		expect(list.items[0].body).toBe('en|app:notify_draft_waiting_body_by|Purge notes');
	});
});

describe('reading and preferences', () => {
	it('marks only the own notifications as read', async () => {
		const a = await k.member('admin');
		const b = await k.member('member');
		for (const key of ['app:one', 'app:two']) {
			await k.ctx.notify({
				kind: 'notes.announced',
				to: { members: [a.member.id, b.member.id] },
				title: { key },
				dedupeKey: key,
			});
		}
		await k.worker.drain();
		const list = (actor: typeof a.actor) => k.route('core.listNotifications').call({ actor });
		expect((await list(a.actor)).unread).toBe(2);

		const first = (await list(a.actor)).items[1];
		await k.runner.invoke('core.markNotificationsRead', { ids: [first.id] }, a.actor);
		expect((await list(a.actor)).unread).toBe(1);
		// Someone else's ids do nothing.
		await k.runner.invoke('core.markNotificationsRead', { ids: [first.id] }, b.actor);
		const bOwn = (await list(b.actor)).items[0].id;
		await k.runner.invoke(
			'core.markNotificationsRead',
			{ ids: [(await list(a.actor)).items[0].id] },
			b.actor,
		);
		expect((await list(b.actor)).unread).toBe(2);
		expect(bOwn).toBeDefined();

		await k.runner.invoke('core.markNotificationsRead', {}, a.actor);
		await k.runner.invoke('core.markNotificationsRead', {}, a.actor); // idempotent
		expect((await list(a.actor)).unread).toBe(0);
		expect((await list(b.actor)).unread).toBe(2);
		expect((await list(a.actor)).items.map((i: { read: boolean }) => i.read)).toEqual([true, true]);
	});

	it('validates preferences and keeps them per member', async () => {
		const a = await k.member('admin');
		const b = await k.member('member');
		const bad = [
			{ kinds: {}, quietHours: { start: '25:00', end: '07:00' } },
			{ kinds: {}, quietHours: { start: '22:00' } },
			{ kinds: { 'notes.nope': { webpush: true } }, quietHours: null },
			{ kinds: { 'notes.quiet': { webpush: 'yes' } }, quietHours: null },
		];
		for (const prefs of bad)
			await expect(setPrefs(a.actor, prefs)).rejects.toMatchObject({ code: 'bad_request' });

		await setPrefs(a.actor, {
			kinds: { 'notes.quiet': { webpush: true } },
			quietHours: { start: '22:00', end: '07:00' },
		});
		// Kinds not sent keep their choice; quiet hours can be cleared.
		await setPrefs(a.actor, {
			kinds: { 'core.draftWaiting': { telegram: false } },
			quietHours: null,
		});

		const route = k.route('core.getNotificationPreferences');
		const mine = await route.call({ actor: a.actor });
		expect(mine.prefs).toEqual({
			kinds: { 'notes.quiet': { webpush: true }, 'core.draftWaiting': { telegram: false } },
			quietHours: null,
		});
		expect(mine.kinds).toEqual([
			{
				id: 'core.draftWaiting',
				label: 'en|app:notify_kind_draft_waiting|',
				defaultChannels: ['webpush', 'telegram'],
			},
			{
				id: 'core.draftDecided',
				label: 'en|app:notify_kind_draft_decided|',
				defaultChannels: ['webpush', 'telegram'],
			},
			{
				id: 'core.backupFailed',
				label: 'en|app:notify_kind_backup_failed|',
				defaultChannels: ['webpush', 'telegram'],
			},
			{
				id: 'core.backupRestored',
				label: 'en|app:notify_kind_backup_restored|',
				defaultChannels: ['webpush', 'telegram'],
			},
			{
				id: 'core.aiAppConnected',
				label: 'en|app:notify_kind_ai_app_connected|',
				defaultChannels: ['webpush', 'telegram'],
			},
			{
				id: 'core.aiAppDisconnected',
				label: 'en|app:notify_kind_ai_app_disconnected|',
				defaultChannels: ['webpush', 'telegram'],
			},
			{
				id: 'core.autoApprovalStopped',
				label: 'en|app:notify_kind_auto_approval_stopped|',
				defaultChannels: ['webpush', 'telegram'],
			},
			{
				id: 'notes.announced',
				label: 'en|notes:notify_kind_announced|',
				defaultChannels: ['webpush', 'telegram'],
			},
			{ id: 'notes.quiet', label: 'en|notes:notify_kind_quiet|', defaultChannels: ['telegram'] },
		]);
		expect(mine.channels).toEqual([
			{ id: 'webpush', label: 'en|app:channel_webpush|', available: true },
			{ id: 'telegram', label: 'en|app:channel_telegram|', available: true },
		]);
		expect((await route.call({ actor: b.actor })).prefs).toEqual({ kinds: {}, quietHours: null });
	});

	it('hides kinds whose audience a member lacks, and refuses to set them', async () => {
		const a = await k.member('admin');
		const m = await k.member('member');
		const route = k.route('core.getNotificationPreferences');
		const ids = async (actor: typeof a.actor) =>
			(await route.call({ actor })).kinds.map((x: { id: string }) => x.id);
		expect(await ids(a.actor)).toContain('core.backupFailed');
		expect(await ids(m.actor)).not.toContain('core.backupFailed');
		expect(await ids(m.actor)).toContain('core.draftWaiting');
		await expect(
			setPrefs(m.actor, { kinds: { 'core.backupFailed': { webpush: false } }, quietHours: null }),
		).rejects.toMatchObject({ code: 'bad_request' });
		await setPrefs(a.actor, {
			kinds: { 'core.backupFailed': { webpush: false } },
			quietHours: null,
		});
	});

	it('only members can read or change notifications', async () => {
		await expect(
			k.runner.invoke('core.markNotificationsRead', {}, systemActor('test')),
		).rejects.toMatchObject({ code: 'forbidden' });
	});
});

describe('kinds', () => {
	it('must be namespaced by their extension and unique', () => {
		const kind = (id: string) => defineNotificationKind({ id, label: 'x:y' });
		expect(() => defineNotificationKind({ id: 'nodots', label: 'x:y' })).toThrow(/Invalid/);
		expect(() => defineTestExtension({ id: 'mine', notifications: [kind('other.thing')] })).toThrow(
			/namespaced/,
		);
		const a = defineTestExtension({ id: 'mine', notifications: [kind('mine.thing')] });
		expect(buildRegistry([a]).notificationKinds.has('mine.thing')).toBe(true);
		expect(() =>
			buildRegistry([a, { ...a, id: 'copy', notifications: [kind('mine.thing')] }]),
		).toThrow(/namespaced|Duplicate/);
	});

	it('must name a declared capability as their audience', () => {
		const ext = (audience: string) =>
			defineTestExtension({
				id: 'mine',
				notifications: [defineNotificationKind({ id: 'mine.thing', label: 'x:y', audience })],
			});
		expect(() => buildRegistry([ext('mine.nope')])).toThrow(/unknown capability/);
	});
});

describe('absoluteLink', () => {
	it('joins a path on the family address and refuses anything that leaves it', () => {
		expect(absoluteLink('https://home.example/', '/tasks')).toBe('https://home.example/tasks');
		expect(absoluteLink('https://home.example', '/\\evil.example')).toBeNull();
		expect(absoluteLink('https://home.example', '//evil.example')).toBeNull();
		expect(absoluteLink(undefined, '/tasks')).toBeNull();
	});
});
