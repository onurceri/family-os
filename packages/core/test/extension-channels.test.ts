import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineNotificationKind, type NotificationChannelDefinition } from '@famos/sdk';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRegistry } from '../src/registry.ts';
import { notesExtension } from './fixtures.ts';
import {
	createTestKernel,
	defineTestExtension,
	type FakeExtensionChannel,
	fakeChannel,
	fakeExtensionChannel,
	type TestKernel,
} from './harness.ts';

/** A kind that names no default channels, and one that names the extension's channel. */
const kinds = [
	defineNotificationKind({ id: 'hub.ping', label: 'hub:kind_ping' }),
	defineNotificationKind({ id: 'hub.alarm', label: 'hub:kind_alarm', defaultChannels: ['hub'] }),
	defineNotificationKind({
		id: 'hub.plain',
		label: 'hub:kind_plain',
		defaultChannels: ['webpush'],
	}),
];

const hubExtension = (channels: readonly NotificationChannelDefinition[]) =>
	defineTestExtension({
		id: 'hub',
		migrations: {
			'0001_create_log': {
				async up(db) {
					await db.schema
						.createTable('hub_log')
						.addColumn('id', 'text', (c) => c.primaryKey())
						.modifyEnd(sql`strict`)
						.execute();
				},
			},
		},
		notifications: kinds,
		channels,
	});

const open: TestKernel[] = [];
afterEach(async () => {
	await Promise.all(open.splice(0).map((k) => k.close()));
});

async function start(
	channel: FakeExtensionChannel,
	options: Parameters<typeof createTestKernel>[0] = {},
) {
	const k = await createTestKernel({
		extensions: [notesExtension, hubExtension([channel])],
		translate: (_locale, key) => key,
		...options,
	});
	open.push(k);
	return k;
}

const ping = (k: TestKernel, memberId: string, kind = 'hub.ping', url?: string) =>
	k.ctx.notify({
		kind,
		to: { members: [memberId] },
		title: { key: 'app:title' },
		...(url && { url }),
	});

describe('declaring a channel', () => {
	it('takes the extension id or `<id>.<name>` and nothing else', () => {
		const channel = fakeExtensionChannel('other');
		expect(() => hubExtension([channel])).toThrow(/must be "hub" or "hub\.…"/);
		expect(() => hubExtension([fakeExtensionChannel('hub.second')])).not.toThrow();
		expect(() => hubExtension([fakeExtensionChannel('hubby')])).toThrow(/must be "hub"/);
	});

	it('is checked again by the registry, whatever the extension claims', () => {
		const forged = { ...hubExtension([]), channels: [fakeExtensionChannel('other')] };
		expect(() => buildRegistry([forged])).toThrow(/must be "hub" or "hub\.…"/);
	});

	it('refuses two channels with one id, and a host channel taken', async () => {
		const twice = hubExtension([fakeExtensionChannel('hub.a'), fakeExtensionChannel('hub.a')]);
		expect(() => buildRegistry([twice])).toThrow(/"hub\.a" is already taken by "hub"/);

		const taken = hubExtension([fakeExtensionChannel('hub')]);
		expect(() => buildRegistry([taken], [], ['hub'])).toThrow(/already taken by the host/);
		const forged = { ...hubExtension([]), channels: [fakeExtensionChannel('hub.webpush')] };
		expect(() => buildRegistry([forged], [], ['webpush'])).not.toThrow();
		await expect(
			createTestKernel({
				extensions: [hubExtension([fakeExtensionChannel('hub')])],
				channels: [fakeChannel('hub')],
			}),
		).rejects.toThrow(/already taken by the host/);
	});
});

describe('defaults', () => {
	it('is on for a kind without default channels unless the channel says off', async () => {
		const on = fakeExtensionChannel('hub');
		const k = await start(on);
		const a = await k.member('admin');
		await ping(k, a.member.id);
		await k.worker.drain();
		expect(on.sent.map((s) => s.memberId)).toEqual([a.member.id]);

		const off = fakeExtensionChannel('hub', { byDefault: 'off' });
		const k2 = await start(off);
		const b = await k2.member('admin');
		await ping(k2, b.member.id);
		await k2.worker.drain();
		expect(off.sent).toEqual([]);
	});

	it("follows a kind's own list over the channel's default, both ways", async () => {
		const off = fakeExtensionChannel('hub', { byDefault: 'off' });
		const k = await start(off);
		const a = await k.member('admin');
		await ping(k, a.member.id, 'hub.alarm'); // names the channel: on although off by default
		await k.worker.drain();
		expect(off.sent).toHaveLength(1);

		const on = fakeExtensionChannel('hub');
		const k2 = await start(on);
		const b = await k2.member('admin');
		await ping(k2, b.member.id, 'hub.plain'); // names web push only
		await k2.worker.drain();
		expect(on.sent).toEqual([]);
	});

	it('lets a member turn an off channel on, and an on channel off', async () => {
		const off = fakeExtensionChannel('hub', { byDefault: 'off' });
		const k = await start(off);
		const a = await k.member('admin');
		const b = await k.member('member');
		await k.runner.invoke(
			'core.setNotificationPreferences',
			{ kinds: { 'hub.ping': { hub: true } }, quietHours: null },
			a.actor,
		);
		await k.ctx.notify({
			kind: 'hub.ping',
			to: { members: [a.member.id, b.member.id] },
			title: { key: 'app:title' },
		});
		await k.worker.drain();
		expect(off.sent.map((s) => s.memberId)).toEqual([a.member.id]);

		const on = fakeExtensionChannel('hub');
		const k2 = await start(on);
		const c = await k2.member('admin');
		await k2.runner.invoke(
			'core.setNotificationPreferences',
			{ kinds: { 'hub.alarm': { hub: false } }, quietHours: null },
			c.actor,
		);
		await ping(k2, c.member.id, 'hub.alarm');
		await k2.worker.drain();
		expect(on.sent).toEqual([]);
	});

	it('gives the same defaults, a hint for who cannot be reached, and nothing for who can', async () => {
		const channel = fakeExtensionChannel('hub', { byDefault: 'off', hint: 'hub:channel_hint' });
		const k = await start(channel);
		const a = await k.member('admin');
		const b = await k.member('member');
		channel.available = [a.member.id];
		const route = k.route('core.getNotificationPreferences');

		const mine = await route.call({ actor: a.actor });
		expect(mine.channels.find((c: { id: string }) => c.id === 'hub')).toEqual({
			id: 'hub',
			label: 'hub:channel_label',
			available: true,
		});
		const others = await route.call({ actor: b.actor });
		expect(others.channels.find((c: { id: string }) => c.id === 'hub')).toEqual({
			id: 'hub',
			label: 'hub:channel_label',
			available: false,
			hint: 'hub:channel_hint',
		});

		const defaults = (data: typeof mine, kind: string) =>
			data.kinds.find((x: { id: string }) => x.id === kind).defaultChannels;
		expect(defaults(mine, 'hub.ping')).toEqual([]); // off by default, no web push in this kernel
		expect(defaults(mine, 'hub.alarm')).toEqual(['hub']);
		expect(defaults(mine, 'hub.plain')).toEqual(['webpush']);
	});

	it('lists the channel as on by default when it does not say', async () => {
		const k = await start(fakeExtensionChannel('hub'));
		const a = await k.member('admin');
		const data = await k.route('core.getNotificationPreferences').call({ actor: a.actor });
		expect(data.kinds.find((x: { id: string }) => x.id === 'hub.ping').defaultChannels).toEqual([
			'hub',
		]);
	});
});

describe('delivery', () => {
	it('gives send the extension its own context: its table, not another extension’s', async () => {
		const channel = fakeExtensionChannel('hub');
		const seen: { own: unknown; foreign: unknown } = { own: null, foreign: null };
		channel.onSend = async (ctx) => {
			seen.own = await ctx.db
				.withTables<{ hub_log: { id: string } }>()
				.selectFrom('hub_log')
				.selectAll()
				.execute();
			seen.foreign = await ctx.db
				.withTables<{ notes_items: { id: string } }>()
				.selectFrom('notes_items')
				.selectAll()
				.execute()
				.catch((error: { code?: string }) => error.code);
			// It is a job context: it may post, which a request context may not.
			expect(typeof ctx.http.post).toBe('function');
		};
		const k = await start(channel);
		const a = await k.member('admin');
		await ping(k, a.member.id);
		await k.worker.drain();
		expect(channel.sent).toHaveLength(1);
		expect(seen.own).toEqual([]);
		expect(seen.foreign).toBe('forbidden');
	});

	it('asks availability with the extension’s own context too', async () => {
		const channel = fakeExtensionChannel('hub');
		const asked: unknown[] = [];
		channel.available = async (ctx) => {
			asked.push(
				await ctx.db
					.withTables<{ hub_log: { id: string } }>()
					.selectFrom('hub_log')
					.selectAll()
					.execute(),
			);
			return true;
		};
		const k = await start(channel);
		const a = await k.member('admin');
		await ping(k, a.member.id);
		await k.worker.drain();
		expect(asked.length).toBeGreaterThan(0);
	});

	it('drops a queued delivery once the extension is gone', async () => {
		const dbPath = join(await mkdtemp(join(tmpdir(), 'famos-channel-')), 'famos.db');
		const channel = fakeExtensionChannel('hub');
		const before = await createTestKernel({
			dbPath,
			extensions: [hubExtension([channel])],
		});
		const a = await before.member('admin');
		// Quiet hours keep the delivery queued for the morning.
		await before.runner.invoke(
			'core.setNotificationPreferences',
			{ kinds: {}, quietHours: { start: '22:00', end: '07:00' } },
			a.actor,
		);
		before.clock.advance(14 * 60 * 60 * 1000);
		await ping(before, a.member.id);
		await before.worker.drain();
		expect(channel.sent).toEqual([]);
		await before.close();

		const after = await createTestKernel({ dbPath, extensions: [] });
		open.push(after);
		after.clock.advance(24 * 60 * 60 * 1000);
		await after.worker.drain();
		expect(channel.sent).toEqual([]);
		expect(channel.attempts).toBe(0);
	});

	it('waits out quiet hours like any channel', async () => {
		const channel = fakeExtensionChannel('hub');
		const k = await start(channel);
		const a = await k.member('admin');
		await k.runner.invoke(
			'core.setNotificationPreferences',
			{ kinds: {}, quietHours: { start: '22:00', end: '07:00' } },
			a.actor,
		);
		k.clock.advance(14 * 60 * 60 * 1000); // 23:00
		await ping(k, a.member.id);
		await k.worker.drain();
		expect(channel.sent).toEqual([]);
		k.clock.advance(8 * 60 * 60 * 1000); // 07:00
		await k.worker.drain();
		expect(channel.sent).toHaveLength(1);
	});

	it('does not let a failing availability check stop the notification or the other channels', async () => {
		const channel = fakeExtensionChannel('hub');
		channel.available = async () => {
			throw new Error('hub is down');
		};
		const web = fakeChannel('webpush');
		const k = await start(channel, { channels: [web] });
		const a = await k.member('admin');
		await ping(k, a.member.id, 'hub.plain');
		await k.worker.drain();
		expect(web.sent).toHaveLength(1);
		expect(channel.attempts).toBe(0);
		// The preferences page shows it as not available.
		const data = await k.route('core.getNotificationPreferences').call({ actor: a.actor });
		expect(data.channels.find((c: { id: string }) => c.id === 'hub').available).toBe(false);
	});

	it('retries a send that throws, and treats `gone` as final', async () => {
		const channel = fakeExtensionChannel('hub');
		channel.next(new Error('later'), 'gone');
		const k = await start(channel);
		const a = await k.member('admin');
		await ping(k, a.member.id);
		await k.worker.drain();
		expect(channel.attempts).toBe(1);
		k.clock.advance(24 * 60 * 60 * 1000);
		await k.worker.drain();
		expect(channel.attempts).toBe(2);
		expect(channel.sent).toHaveLength(1);
		k.clock.advance(24 * 60 * 60 * 1000);
		await k.worker.drain();
		expect(channel.attempts).toBe(2);
	});

	it('leaves out the channel of an extension that is turned off', async () => {
		const channel = fakeExtensionChannel('hub');
		const k = await start(channel);
		const a = await k.member('admin');
		await k.runner.invoke(
			'core.setFeatureEnabled',
			{ extensionId: 'hub', enabled: false },
			a.actor,
		);
		const data = await k.route('core.getNotificationPreferences').call({ actor: a.actor });
		expect(data.channels).toEqual([]);
	});
});

describe('links', () => {
	it('is the absolute address with a public URL, and null without one', async () => {
		const withUrl = fakeExtensionChannel('hub');
		const k = await start(withUrl, { publicUrl: 'https://family.example/' });
		const a = await k.member('admin');
		await ping(k, a.member.id, 'hub.ping', '/add?x=1');
		await ping(k, a.member.id, 'hub.ping');
		await k.worker.drain();
		expect(withUrl.sent.map((s) => [s.message.url, s.message.link])).toEqual(
			expect.arrayContaining([
				['/add?x=1', 'https://family.example/add?x=1'],
				[null, null],
			]),
		);

		const without = fakeExtensionChannel('hub');
		const k2 = await start(without);
		const b = await k2.member('admin');
		await ping(k2, b.member.id, 'hub.ping', '/add');
		await k2.worker.drain();
		expect(without.sent.map((s) => [s.message.url, s.message.link])).toEqual([['/add', null]]);
	});
});
