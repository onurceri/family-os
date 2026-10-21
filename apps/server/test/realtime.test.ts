import { silentLogger } from '@famos/adapters/runtime';
import { sessionEnded } from '@famos/core';
import { type Actor, defineEvent, type MemberId, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createRealtimeHub, realtimeGuard } from '../src/http/realtime.ts';
import { discoverSourceExtensions } from './support/extensions.ts';

const extensions = await discoverSourceExtensions();

// Events a test adds to what the extensions declare: one with no audience in an area that has a
// view capability, and one whose area has none.
const unlistedCalendar = defineEvent('calendar.unlisted.changed', z.object({}));
const unlistedNowhere = defineEvent('nowhere.unlisted.changed', z.object({}));

let k: TestKernel;

beforeEach(async () => {
	k = await createTestKernel({ extensions });
	k.clock.set(Date.UTC(2026, 9, 19, 7));
});
afterEach(() => k.close());

const hubOf = () =>
	createRealtimeHub(
		k.bus,
		silentLogger,
		k.access,
		new Map([
			...k.registry.events,
			[unlistedCalendar.name, unlistedCalendar],
			[unlistedNowhere.name, unlistedNowhere],
		]),
	);

type Socket = { ws: WSContext; names: () => string[]; closed: () => boolean };
const connect = (hub: ReturnType<typeof hubOf>, actor: Actor): Socket => {
	const send = vi.fn();
	const close = vi.fn();
	const ws = { send, close } as unknown as WSContext;
	hub.events(actor).onOpen(undefined, ws);
	return {
		ws,
		names: () =>
			send.mock.calls
				.map((call) => JSON.parse(call[0] as string) as { type: string; name?: string })
				// Setting up members in a test announces each one to those already connected.
				.filter((message) => message.type === 'event' && message.name !== 'core.member.changed')
				.map((message) => message.name as string),
		closed: () => close.mock.calls.length > 0,
	};
};
const display = (capabilities: string[], deviceId = 'dev_1'): Actor => ({
	kind: 'display',
	deviceId,
	capabilities,
	showNames: false,
});

async function roleWithout(...capabilities: string[]) {
	const result = await k.runner.invoke<{ id: string }>(
		'core.createRole',
		{
			name: 'Limited',
			base: 'member',
			overrides: Object.fromEntries(capabilities.map((c) => [c, false])),
		},
		systemActor('test'),
	);
	if (result.status !== 'applied') throw new Error('expected the role to be created');
	return result.output.id;
}

describe('who hears of an event', () => {
	it('never tells a display of an area it was not granted', async () => {
		const hub = hubOf();
		const calendarOnly = connect(hub, display(['calendar.view'], 'dev_a'));
		const listsOnly = connect(hub, display(['lists.view'], 'dev_b'));
		const nothing = connect(hub, display([], 'dev_c'));

		await k.bus.publish('calendar.event.changed', { eventId: 'e' });
		await k.bus.publish('lists.task.changed', { taskId: 't' });
		await k.bus.publish('records.document.changed', { recordId: 'r' });
		await k.bus.publish('core.draft.created', { draftId: 'd' });

		expect(calendarOnly.names()).toEqual(['calendar.event.changed']);
		expect(listsOnly.names()).toEqual(['lists.task.changed']);
		expect(nothing.names()).toEqual([]);
	});

	it('tells a display what every screen shows, and a settings page only its managers', async () => {
		const hub = hubOf();
		const screen = connect(hub, display([]));
		const admin = connect(hub, (await k.member('admin')).actor);

		await k.bus.publish('core.themes.changed', { id: null });
		await k.bus.publish('core.family.changed', {});
		await k.bus.publish('core.device.changed', { deviceId: 'dev_other' });
		await k.bus.publish('core.telegram.status.changed', {});
		await k.bus.publish('core.email.status.changed', {});

		expect(screen.names()).toEqual(['core.themes.changed', 'core.family.changed']);
		// It hears of its own device changing (it checks again, and a revoked one pairs anew), as the
		// socket closes.
		await k.bus.publish('core.device.changed', { deviceId: 'dev_1' });
		expect(screen.names()).toEqual([
			'core.themes.changed',
			'core.family.changed',
			'core.device.changed',
		]);
		expect(screen.closed()).toBe(true);
		expect(admin.names()).toEqual([
			'core.themes.changed',
			'core.family.changed',
			'core.device.changed',
			'core.telegram.status.changed',
			'core.email.status.changed',
			'core.device.changed',
		]);
	});

	it('gives a member without calendar.view no calendar events', async () => {
		const hub = hubOf();
		const limited = await k.member(await roleWithout('calendar.view'), 'Limited');
		const plain = await k.member('member', 'Plain');
		const guest = connect(hub, limited.actor);
		const member = connect(hub, plain.actor);

		await k.bus.publish('calendar.event.changed', { eventId: 'e' });
		await k.bus.publish('calendar.subscription.changed', { subscriptionId: 's' });
		await k.bus.publish('calendar.tag.changed', {});
		await k.bus.publish('lists.task.changed', { taskId: 't' });

		expect(guest.names()).toEqual(['lists.task.changed']);
		expect(member.names()).toEqual([
			'calendar.event.changed',
			'calendar.subscription.changed',
			'calendar.tag.changed',
			'lists.task.changed',
		]);
	});

	it('is closed by default: an event with no audience goes to the holders of its owner’s view only', async () => {
		const hub = hubOf();
		const calendarScreen = connect(hub, display(['calendar.view'], 'dev_a'));
		const listsScreen = connect(hub, display(['lists.view'], 'dev_b'));
		const limited = connect(
			hub,
			(await k.member(await roleWithout('calendar.view'), 'Limited')).actor,
		);
		const admin = connect(hub, (await k.member('admin')).actor);

		await k.bus.publish(unlistedCalendar.name, {});
		// Nobody owns a view capability here, so not even an admin hears of it.
		await k.bus.publish(unlistedNowhere.name, {});

		expect(calendarScreen.names()).toEqual([unlistedCalendar.name]);
		expect(admin.names()).toEqual([unlistedCalendar.name]);
		expect(listsScreen.names()).toEqual([]);
		expect(limited.names()).toEqual([]);
	});

	it('tells one member alone of what is theirs', async () => {
		const hub = hubOf();
		const ayse = await k.member('member', 'Ayse');
		const can = await k.member('member', 'Can');
		const admin = await k.member('admin', 'Admin');
		const sockets = {
			ayse: connect(hub, ayse.actor),
			can: connect(hub, can.actor),
			admin: connect(hub, admin.actor),
			screen: connect(hub, display(['inbox.share', 'core.drafts.waiting'])),
		};

		await k.bus.publish('inbox.item.changed', { itemId: 'i', memberId: ayse.member.id });
		await k.bus.publish('core.notification.created', { memberId: can.member.id });
		await k.bus.publish('core.draft.updated', {
			draftId: 'd',
			status: 'pending',
			forMember: ayse.member.id,
		});

		expect(sockets.ayse.names()).toEqual(['inbox.item.changed', 'core.draft.updated']);
		expect(sockets.can.names()).toEqual(['core.notification.created']);
		expect(sockets.admin.names()).toEqual([]);
		expect(sockets.screen.names()).toEqual([]);
	});

	it('tells a duty’s change only to those who see its area', async () => {
		const hub = hubOf();
		const noVehicles = connect(
			hub,
			(await k.member(await roleWithout('vehicles.view'), 'No vehicles')).actor,
		);
		const family = connect(hub, (await k.member('member', 'Family')).actor);
		const screen = connect(hub, display(['records.view']));

		await k.bus.publish('records.obligation.changed', {
			recordId: 'vehicle_1',
			audience: 'vehicles.view',
		});
		await k.bus.publish('records.obligation.changed', {
			recordId: 'home_1',
			audience: 'records.view',
		});

		expect(family.names()).toEqual(['records.obligation.changed', 'records.obligation.changed']);
		expect(noVehicles.names()).toEqual(['records.obligation.changed']);
		expect(screen.names()).toEqual(['records.obligation.changed']);
	});

	it('names the area of every duty it changes', async () => {
		const seen: { name: string; payload: unknown }[] = [];
		k.bus.onAny((name, payload) => void seen.push({ name, payload }));
		const admin = await k.member('admin');
		const record = 'vehicle_00000000-0000-7000-8000-000000000001';
		const result = await k.runner.invoke<{ id: string }>(
			'records.addObligation',
			{
				recordId: record,
				recordKind: 'vehicle',
				recordName: 'Golf',
				title: 'Insurance',
				dueDate: '2026-11-20',
				audience: 'vehicles.view',
			},
			admin.actor,
		);
		if (result.status !== 'applied') throw new Error('expected the duty to be added');
		expect(seen).toContainEqual({
			name: 'records.obligation.changed',
			payload: { recordId: record, audience: 'vehicles.view' },
		});

		// Renaming the record tells each area that has a duty on it, and no other.
		seen.length = 0;
		await k.runner.invoke(
			'records.renameRecord',
			{ recordId: record, name: 'Passat' },
			systemActor('test'),
		);
		expect(seen.map((e) => e.payload)).toEqual([{ recordId: record, audience: 'vehicles.view' }]);
	});

	it('does not carry a tag’s name', async () => {
		const seen: unknown[] = [];
		k.bus.onAny((name, payload) => {
			if (name === 'calendar.tag.changed') seen.push(payload);
		});
		const admin = await k.member('admin');
		await k.runner.invoke(
			'calendar.createEvent',
			{ title: 'Checkup', date: '2026-10-20', startTime: '10:00', tags: ['Health'] },
			admin.actor,
		);
		await k.runner.invoke('calendar.updateTag', { name: 'Health', newName: 'Doctor' }, admin.actor);
		expect(seen).toEqual([{}]);
	});

	it('keeps a private assistant answer to the member it is for, while they may still use it', async () => {
		const hub = hubOf();
		const ayse = await k.member('member', 'Ayse');
		const can = await k.member('member', 'Can');
		const limited = await k.member(await roleWithout('assistant.use'), 'Limited');
		const sockets = [
			connect(hub, ayse.actor),
			connect(hub, can.actor),
			connect(hub, limited.actor),
		];
		const screen = connect(hub, display(['assistant.use']));

		await k.bus.publishTo(ayse.member.id, 'assistant.delta', {
			threadId: 't',
			messageId: 'm',
			text: 'private',
		});
		await k.bus.publishTo(limited.member.id, 'assistant.delta', {
			threadId: 't',
			messageId: 'm',
			text: 'private',
		});

		expect(sockets.map((s) => s.names())).toEqual([['assistant.delta'], [], []]);
		expect(screen.names()).toEqual([]);
	});
});

describe('closing sockets', () => {
	it('closes an archived member’s socket, and only theirs', async () => {
		const hub = hubOf();
		const admin = await k.member('admin');
		const leaving = await k.member('member', 'Leaving');
		const staying = await k.member('member', 'Staying');
		const gone = connect(hub, leaving.actor);
		const stays = connect(hub, staying.actor);
		const screen = connect(hub, display(['calendar.view']));

		const result = await k.runner.invoke(
			'core.archiveMember',
			{ memberId: leaving.member.id },
			admin.actor,
		);
		expect(result.status).toBe('applied');

		expect(gone.closed()).toBe(true);
		expect(stays.closed()).toBe(false);
		expect(screen.closed()).toBe(false);
	});

	it('closes a member’s socket when their role changes', async () => {
		const hub = hubOf();
		const admin = await k.member('admin');
		const person = await k.member('member', 'Person');
		const socket = connect(hub, person.actor);

		await k.runner.invoke(
			'core.updateMember',
			{ memberId: person.member.id, roleId: 'guest' },
			admin.actor,
		);
		expect(socket.closed()).toBe(true);
	});

	it('closes a member’s sockets on sign-out everywhere and on a new password', async () => {
		const hub = hubOf();
		const admin = await k.member('admin');
		const person = await k.member('member', 'Person');
		const second = await k.member('member', 'Second');

		const everywhere = connect(hub, person.actor);
		const other = connect(hub, second.actor);
		await k.route('core.signOutEverywhere').call({ actor: person.actor });
		expect(everywhere.closed()).toBe(true);
		expect(other.closed()).toBe(false);

		const changed = connect(hub, second.actor);
		await k.route('core.setMemberPassword').call({
			actor: admin.actor,
			params: { memberId: second.member.id },
			body: { email: 'second@example.com', password: 'a long enough password' },
		});
		expect(changed.closed()).toBe(true);
		expect(other.closed()).toBe(true);
	});

	it('closes a member’s sockets when the server ends their session', async () => {
		const hub = hubOf();
		const person = await k.member('member', 'Person');
		const socket = connect(hub, person.actor);
		await k.bus.emit(sessionEnded, { memberId: person.member.id });
		expect(socket.closed()).toBe(true);
		// A transport signal: nobody is told in words.
		expect(socket.names()).toEqual([]);
	});

	it('closes a display’s socket, and a PIN session’s, when a device changes', async () => {
		const hub = hubOf();
		const person = await k.member('member', 'Person');
		const kiosk = connect(hub, display(['calendar.view'], 'dev_1'));
		const otherKiosk = connect(hub, display(['calendar.view'], 'dev_2'));
		const pin = connect(hub, { ...person.actor, pin: true });
		const password = connect(hub, person.actor);

		await k.bus.publish('core.device.changed', { deviceId: 'dev_1' });

		expect(kiosk.closed()).toBe(true);
		expect(pin.closed()).toBe(true);
		expect(otherKiosk.closed()).toBe(false);
		expect(password.closed()).toBe(false);
	});
});

describe('the socket guard', () => {
	const app = (trusted: string[], actor: Actor | null) => {
		const guarded = new Hono();
		guarded.get(
			'/ws',
			realtimeGuard(trusted, () => actor),
			(c) => c.text('upgraded'),
		);
		return guarded;
	};
	const member = { kind: 'member', memberId: 'member_a' as MemberId, roleId: 'member' } as const;
	const open = (trusted: string[], actor: Actor | null, origin?: string) =>
		app(trusted, actor).request('/ws', origin === undefined ? {} : { headers: { origin } });

	it('refuses an origin that is neither the base URL nor trusted', async () => {
		const trusted = ['http://famos.home:3000', 'https://famos.example'];
		expect((await open(trusted, member, 'http://famos.home:8123')).status).toBe(403);
		expect((await open(trusted, member, 'https://evil.example')).status).toBe(403);
		expect((await open(trusted, member, 'null')).status).toBe(403);
	});

	it('lets the app’s own pages and clients that send no origin through', async () => {
		const trusted = ['http://famos.home:3000', 'https://famos.example'];
		expect((await open(trusted, member, 'http://famos.home:3000')).status).toBe(200);
		expect((await open(trusted, member, 'https://famos.example')).status).toBe(200);
		expect((await open(trusted, member)).status).toBe(200);
	});

	it('still needs someone signed in or a paired display', async () => {
		expect((await open(['http://a'], null, 'http://a')).status).toBe(401);
		expect((await open(['http://a'], display([]), 'http://a')).status).toBe(200);
	});
});

describe('every event has an audience', () => {
	it('declares one, so no event falls back to the closed default by accident', () => {
		const without = [...k.registry.events.values()]
			.filter((event) => event.audience === undefined)
			.map((event) => event.name);
		expect(without).toEqual([]);
		// The extensions and core between them declare a good many.
		expect(k.registry.events.size).toBeGreaterThan(30);
	});

	it('never names a capability that does not exist', async () => {
		const samples: Record<string, unknown> = {
			'records.obligation.changed': { recordId: 'r', audience: 'records.view' },
		};
		const unknown: string[] = [];
		for (const event of [...k.registry.events.values()]) {
			const rule = event.audience;
			if (rule === undefined) continue;
			const targets = typeof rule === 'function' ? rule(samples[event.name] ?? {}) : rule;
			for (const target of Array.isArray(targets) ? targets : [targets])
				if (typeof target === 'string' && !k.access.capability(target))
					unknown.push(`${event.name} -> ${target}`);
		}
		expect(unknown).toEqual([]);
	});
});
