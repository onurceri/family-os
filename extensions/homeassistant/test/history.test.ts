import { type Actor, ExternalHttpError } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Item, SwitchEntry, SwitchHistory } from '../src/contract/index.ts';
import en from '../src/messages/en.json' with { type: 'json' };
import tr from '../src/messages/tr.json' with { type: 'json' };
import homeassistant from '../src/server/index.ts';
import { describeSwitch, type HistoryDeps, historyKey } from '../src/web/history-words.ts';
import { connectHomeAssistant } from './connect.ts';

const BASE = 'http://192.168.1.20:8123';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.sentinel-payload.sentinel-signature';

let k: TestKernel;
let admin: Actor & { kind: 'member' };
let alex: Actor & { kind: 'member' };

beforeEach(async () => {
	k = await createTestKernel({ extensions: [homeassistant] });
	admin = (await k.member('admin', 'Deniz')).actor;
	alex = (await k.member('member', 'Alex')).actor;
	await connectHomeAssistant(k, admin, BASE, TOKEN);
	await k.worker.drain();
});
afterEach(() => k.close());

async function add(entityId: string, label: string): Promise<Item> {
	const r = await k.runner.invoke<Item>('homeassistant.addItem', { entityId, label }, admin);
	if (r.status !== 'applied') throw new Error('expected applied');
	await k.runner.invoke(
		'homeassistant.setItemControl',
		{ id: r.output.id, control: true, confirm: false },
		admin,
	);
	return r.output;
}
const flip = (id: string, operation: string, who: Actor = admin) =>
	k.runner.invoke('homeassistant.switch', { id, operation }, who);
const history = (
	query: Record<string, unknown> = {},
	actor: Actor = admin,
): Promise<SwitchHistory> => k.route('homeassistant.getSwitchHistory').call({ actor, query });
const serve = (path: string, result: unknown = {}) =>
	// biome-ignore lint/suspicious/noExplicitAny: the fake takes a body or an error.
	k.http.servePost(`${BASE}/api/services/${path}`, result as any);

describe('the switch history', () => {
	it('records who switched what once Home Assistant took it, with the name at the time', async () => {
		const light = await add('light.living_room', 'Living room light');
		serve('light/turn_on');
		await flip(light.id, 'turn_on');
		await k.worker.drain();
		await k.runner.invoke('homeassistant.renameItem', { id: light.id, label: 'Lounge' }, admin);
		const { entries } = await history();
		expect(entries).toEqual([
			{
				id: expect.any(String),
				itemId: light.id,
				entityId: 'light.living_room',
				label: 'Living room light',
				operation: 'turn_on',
				memberId: admin.memberId,
				ok: true,
				at: k.clock.now(),
			},
		]);
	});

	it('records a switch that could not be done as failed', async () => {
		const light = await add('light.living_room', 'Living room light');
		serve('light/turn_on', new ExternalHttpError('http_400'));
		await flip(light.id, 'turn_on');
		await k.worker.drain();
		expect((await history()).entries).toMatchObject([
			{ label: 'Living room light', ok: false, memberId: admin.memberId },
		]);
	});

	it('records a switch that was no longer allowed by the time it ran, as failed', async () => {
		const light = await add('light.living_room', 'Living room light');
		await flip(light.id, 'turn_on');
		await k.runner.invoke(
			'homeassistant.setItemControl',
			{ id: light.id, control: false, confirm: false },
			admin,
		);
		await k.worker.drain();
		expect(k.http.posted).toEqual([]);
		expect((await history()).entries).toMatchObject([{ ok: false }]);
	});

	it('keeps the entry, under the name it had, after the item is removed', async () => {
		const light = await add('light.living_room', 'Living room light');
		serve('light/turn_on');
		await flip(light.id, 'turn_on');
		await k.worker.drain();
		await k.runner.invoke('homeassistant.removeItem', { id: light.id }, admin);
		expect((await history()).entries).toMatchObject([{ label: 'Living room light', ok: true }]);
	});

	it('lists one item’s latest switches, newest first, and no more than asked', async () => {
		const light = await add('light.living_room', 'Living room light');
		const scene = await add('scene.movie_night', 'Movie night');
		serve('light/turn_on');
		serve('light/turn_off');
		serve('scene/turn_on');
		for (const op of ['turn_on', 'turn_off', 'turn_on', 'turn_off', 'turn_on', 'turn_off']) {
			await flip(light.id, op);
			await k.worker.drain();
			k.clock.advance(5_000);
		}
		await flip(scene.id, 'turn_on');
		await k.worker.drain();

		const mine = await history({ itemId: light.id, limit: 5 });
		expect(mine.entries.every((e) => e.itemId === light.id)).toBe(true);
		expect(mine.entries.map((e) => e.operation)).toEqual([
			'turn_off',
			'turn_on',
			'turn_off',
			'turn_on',
			'turn_off',
		]);
		const all = await history({ limit: 20 });
		expect(all.entries).toHaveLength(7);
		expect(all.entries[0]).toMatchObject({ itemId: scene.id });
		expect((await history()).entries).toHaveLength(7);
		expect((await history({ limit: 3 })).entries).toHaveLength(3);
	});

	it('shows the history to anyone who may see Home Assistant, switches or not', async () => {
		expect(k.access.can(alex, 'homeassistant.control')).toBe(false);
		const light = await add('light.living_room', 'Living room light');
		serve('light/turn_on');
		await flip(light.id, 'turn_on');
		await k.worker.drain();
		expect((await history({}, alex)).entries).toHaveLength(1);
		await expect(flip(light.id, 'turn_on', alex)).rejects.toMatchObject({ code: 'forbidden' });
	});

	it('names nobody on a family display unless it was allowed names', async () => {
		const light = await add('light.living_room', 'Living room light');
		serve('light/turn_on');
		await flip(light.id, 'turn_on');
		await k.worker.drain();
		const display = (showNames: boolean): Actor => ({
			kind: 'display',
			deviceId: 'dev',
			capabilities: ['homeassistant.view'],
			showNames,
		});
		expect((await history({}, display(false))).entries[0]?.memberId).toBeNull();
		expect((await history({}, display(true))).entries[0]?.memberId).toBe(admin.memberId);
	});

	it('forgets switches after a quarter of a year', async () => {
		const light = await add('light.living_room', 'Living room light');
		serve('light/turn_on');
		await flip(light.id, 'turn_on');
		await k.worker.drain();
		k.clock.advance(91 * 24 * 60 * 60 * 1000);
		await flip(light.id, 'turn_on');
		await k.worker.drain();
		expect((await history()).entries).toHaveLength(1);
	});
});

describe('saying a switch', () => {
	const entry = (over: Partial<SwitchEntry>): SwitchEntry => ({
		id: 'e1',
		itemId: 'ha_item_1',
		entityId: 'light.living_room',
		label: 'Living room light',
		operation: 'turn_on',
		memberId: 'member_tom',
		ok: true,
		at: 1,
		...over,
	});
	const deps = (catalog: Record<string, string>): HistoryDeps => ({
		t: (key, params) =>
			(catalog[key] as string).replace(/{{(\w+)}}/g, (_, n: string) => params?.[n] ?? ''),
		member: (id) => (id === 'member_tom' ? 'Tom' : id === 'member_mara' ? 'Mara' : null),
		time: (at) => `at ${at}`,
	});
	const say = (e: SwitchEntry, catalog: Record<string, string> = en) =>
		describeSwitch(e, deps(catalog));

	it('reads like a sentence', () => {
		expect(say(entry({})).title).toBe('Tom turned on Living room light');
		expect(say(entry({ operation: 'turn_off' })).title).toBe('Tom turned off Living room light');
		expect(
			say(entry({ entityId: 'scene.movie_night', label: 'Movie night', memberId: 'member_mara' }))
				.title,
		).toBe('Mara ran Movie night');
		const door = { entityId: 'lock.front_door' as const, label: 'Front door' };
		expect(say(entry({ ...door, operation: 'unlock' })).title).toBe('Tom unlocked Front door');
		expect(say(entry({ ...door, operation: 'lock' })).title).toBe('Tom locked Front door');
		const garage = { entityId: 'cover.garage' as const, label: 'Garage' };
		expect(say(entry({ ...garage, operation: 'open_cover' })).title).toBe('Tom opened Garage');
		expect(say(entry({ ...garage, operation: 'close_cover' })).title).toBe('Tom closed Garage');
		expect(say(entry({ ...garage, operation: 'stop_cover' })).title).toBe('Tom stopped Garage');
	});

	it('says a failure plainly, with who asked in the second line', () => {
		expect(say(entry({ ok: false }))).toEqual({
			title: 'Could not switch Living room light',
			meta: 'Tom · at 1',
		});
		expect(say(entry({ ok: false, memberId: null })).meta).toBe('at 1');
	});

	it('says Someone when the member is gone or may not be named', () => {
		expect(say(entry({ memberId: 'member_gone' })).title).toBe(
			'Someone turned on Living room light',
		);
		expect(say(entry({ memberId: null })).title).toBe('Someone turned on Living room light');
	});

	it('runs a script or scene, and turns on everything else', () => {
		expect(historyKey('script.bedtime', 'turn_on')).toBe('history_run');
		expect(historyKey('switch.kettle', 'turn_on')).toBe('history_turn_on');
	});

	it('has every sentence in Turkish too, with the same placeholders', () => {
		const placeholders = (s: string) => [...s.matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort();
		const english = en as Record<string, string>;
		const turkish = tr as Record<string, string>;
		for (const key of Object.keys(english).filter((name) => name.startsWith('history_')))
			expect(placeholders(turkish[key] ?? ''), key).toEqual(placeholders(english[key] ?? ''));
		expect(say(entry({}), turkish).title).toBe('Tom, Living room light öğesini açtı');
	});
});
