import { type Actor, ExternalHttpError } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MySharing, PersonLink, Persons, PresenceList } from '../src/contract/index.ts';
import { SetMySharingInputSchema } from '../src/contract/index.ts';
import homeassistant from '../src/server/index.ts';

const BASE = 'http://192.168.1.20:8123';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.sentinel-payload.sentinel-signature';

let k: TestKernel;
let admin: Actor & { kind: 'member' };
let alex: Actor & { kind: 'member' };
let sam: Actor & { kind: 'member' };

beforeEach(async () => {
	k = await createTestKernel({ extensions: [homeassistant] });
	admin = (await k.member('admin', 'Deniz')).actor;
	alex = (await k.member('member', 'Alex')).actor;
	sam = (await k.member('supervised', 'Sam')).actor;
});
afterEach(() => k.close());

const personBody = (id: string, state: string) => ({
	entity_id: id,
	state,
	attributes: {
		latitude: 52.3601,
		longitude: 4.8866,
		gps_accuracy: 12,
		in_zones: ['zone.home'],
		device_trackers: [`device_tracker.${id.slice(7)}_phone`],
		friendly_name: id.slice(7),
	},
	last_changed: '2026-10-17T07:45:00+00:00',
	last_updated: '2026-10-17T07:45:00+00:00',
	context: { id: 'c', parent_id: null, user_id: null },
});

function servePerson(id: string, state: string) {
	k.http.serve(`${BASE}/api/states/${id}`, { text: JSON.stringify(personBody(id, state)) });
}
const personRequests = () =>
	k.http.requests.filter((r) => r.url.startsWith(`${BASE}/api/states/person.`));

async function connect() {
	await k.runner.invoke('homeassistant.connect', { url: BASE, token: TOKEN }, admin);
}
const link = (memberId: string, personEntity: string, actor: Actor = admin) =>
	k.runner.invoke<PersonLink>('homeassistant.linkPerson', { memberId, personEntity }, actor);
const share = (actor: Actor, level: 'none' | 'home' | 'place', onDisplays = false) =>
	k.runner.invoke<MySharing>('homeassistant.setMySharing', { level, onDisplays }, actor);
const links = async (): Promise<PersonLink[]> =>
	(await k.route('homeassistant.listPeople').call({ actor: admin })).links;
const mine = async (actor: Actor): Promise<MySharing> =>
	k.route('homeassistant.getMySharing').call({ actor });
const presence = async (actor: Actor = admin): Promise<PresenceList> =>
	k.route('homeassistant.getPresence').call({ actor });
const display = (capabilities: string[] = ['homeassistant.presence']): Actor => ({
	kind: 'display',
	deviceId: 'dev',
	capabilities,
	showNames: true,
});
const routeOf = (id: string) => k.registry.routes.find((r) => r.route.operationId === id)?.route;

describe('linking', () => {
	it('is for those who manage Home Assistant, and starts with nothing shown', async () => {
		await expect(link(alex.memberId, 'person.alex', alex)).rejects.toMatchObject({
			code: 'forbidden',
		});
		const made = await link(alex.memberId, 'person.alex');
		expect(made).toMatchObject({ status: 'applied' });
		expect(await links()).toEqual([
			{ memberId: alex.memberId, personEntity: 'person.alex', level: 'none', onDisplays: false },
		]);
		expect(routeOf('homeassistant.listPeople')?.requires).toBe('homeassistant.manage');
		expect(routeOf('homeassistant.listPersons')?.requires).toBe('homeassistant.manage');
	});

	it('refuses a member that does not exist, a person of another member and a non-person', async () => {
		await expect(link('member_nobody', 'person.alex')).rejects.toMatchObject({
			code: 'not_found',
		});
		await link(alex.memberId, 'person.alex');
		await expect(link(sam.memberId, 'person.alex')).rejects.toMatchObject({ code: 'conflict' });
		await expect(link(sam.memberId, 'device_tracker.sam')).rejects.toMatchObject({
			code: 'bad_request',
		});
	});

	it('keeps the choice when linked again to the same person, and resets it for another', async () => {
		await link(alex.memberId, 'person.alex');
		await share(alex, 'place', true);
		await link(alex.memberId, 'person.alex');
		expect((await links())[0]).toMatchObject({ level: 'place', onDisplays: true });
		await link(alex.memberId, 'person.alex_new');
		expect((await links())[0]).toMatchObject({
			personEntity: 'person.alex_new',
			level: 'none',
			onDisplays: false,
		});
	});

	it('unlinks, for those who manage only', async () => {
		await link(alex.memberId, 'person.alex');
		await expect(
			k.runner.invoke('homeassistant.unlinkPerson', { memberId: alex.memberId }, alex),
		).rejects.toMatchObject({ code: 'forbidden' });
		await k.runner.invoke('homeassistant.unlinkPerson', { memberId: alex.memberId }, admin);
		expect(await links()).toEqual([]);
		expect(await mine(alex)).toEqual({ linked: false });
	});
});

describe("a person's own choice", () => {
	it('has no member in it: whoever runs it chooses for themselves', () => {
		expect(Object.keys(SetMySharingInputSchema.shape)).toEqual(['level', 'onDisplays']);
		expect(
			SetMySharingInputSchema.safeParse({
				level: 'place',
				onDisplays: true,
				memberId: 'member_x',
			}).success,
		).toBe(false);
	});

	it('changes only the actor’s own row, even for an admin', async () => {
		await link(alex.memberId, 'person.alex');
		await link(sam.memberId, 'person.sam');
		await link(admin.memberId, 'person.deniz');
		await share(sam, 'home');
		expect(await mine(sam)).toEqual({ linked: true, level: 'home', onDisplays: false });
		await share(admin, 'place', true);
		const byMember = Object.fromEntries((await links()).map((l) => [l.memberId, l]));
		expect(byMember[alex.memberId]).toMatchObject({ level: 'none', onDisplays: false });
		expect(byMember[sam.memberId]).toMatchObject({ level: 'home', onDisplays: false });
		expect(byMember[admin.memberId]).toMatchObject({ level: 'place', onDisplays: true });
	});

	it('is not found for a member who is not linked', async () => {
		await expect(share(alex, 'home')).rejects.toMatchObject({ code: 'not_found' });
		expect(await mine(alex)).toEqual({ linked: false });
	});

	it('turns displays off with Nothing', async () => {
		await link(alex.memberId, 'person.alex');
		expect(await share(alex, 'none', true)).toMatchObject({
			output: { linked: true, level: 'none', onDisplays: false },
		});
	});

	it('can never be run or suggested by the AI, nor by a display', async () => {
		await link(alex.memberId, 'person.alex');
		for (const mode of ['conversation', 'share', 'agent'] as const) {
			await expect(
				share({ kind: 'ai', mode, source: 'assistant', onBehalfOf: alex.memberId }, 'place', true),
			).rejects.toBeTruthy();
			await expect(share({ kind: 'ai', mode, source: 'assistant' }, 'place')).rejects.toBeTruthy();
		}
		await expect(share(display(), 'place')).rejects.toMatchObject({ code: 'forbidden' });
		for (const who of [admin, alex])
			expect(await k.route('core.listDrafts').call({ actor: who, query: { limit: 50 } })).toEqual(
				[],
			);
		expect((await links())[0]).toMatchObject({ level: 'none' });
		const action = k.registry.actions.get('homeassistant.setMySharing');
		expect(action?.ai).toBeUndefined();
	});
});

describe('who is home', () => {
	beforeEach(async () => {
		servePerson('person.alex', 'School');
		servePerson('person.sam', 'home');
		await connect();
		await link(alex.memberId, 'person.alex');
		await link(sam.memberId, 'person.sam');
	});

	it('is for those who may see who is home', () => {
		expect(routeOf('homeassistant.getPresence')?.requires).toBe('homeassistant.presence');
		expect(k.access.can(alex, 'homeassistant.presence')).toBe(true);
		expect(k.access.can(sam, 'homeassistant.presence')).toBe(true);
		expect(k.access.can(display(), 'homeassistant.presence')).toBe(true);
		expect(k.access.can(display([]), 'homeassistant.presence')).toBe(false);
	});

	it('asks nothing about people who chose Nothing, and never returns them', async () => {
		expect(await presence()).toEqual({ people: [], status: 'ok' });
		expect(personRequests()).toEqual([]);
		await share(sam, 'home');
		const result = await presence();
		expect(result).toEqual({
			status: 'ok',
			people: [
				{
					memberId: sam.memberId,
					presence: { kind: 'home' },
					since: Date.parse('2026-10-17T07:45:00+00:00'),
				},
			],
		});
		expect(personRequests().map((r) => r.url)).toEqual([`${BASE}/api/states/person.sam`]);
		for (const hidden of ['latitude', '52.36', 'in_zones', 'device_trackers', 'gps', TOKEN])
			expect(JSON.stringify(result)).not.toContain(hidden);
	});

	it('shows as much as each person chose, and a change at once', async () => {
		await share(alex, 'home');
		expect((await presence()).people[0]?.presence).toEqual({ kind: 'away' });
		await share(alex, 'place');
		expect((await presence()).people[0]?.presence).toEqual({ kind: 'place', name: 'School' });
		await share(alex, 'none');
		expect((await presence()).people).toEqual([]);
	});

	it('shows a display only those who chose displays too, and asks about nobody else', async () => {
		await share(alex, 'place', true);
		await share(sam, 'home', false);
		const before = personRequests().length;
		const seen = await presence(display());
		expect(seen.people.map((p) => p.memberId)).toEqual([alex.memberId]);
		expect(
			personRequests()
				.slice(before)
				.map((r) => r.url),
		).toEqual([`${BASE}/api/states/person.alex`]);
		// A member sees both.
		expect((await presence(alex)).people).toHaveLength(2);
	});

	it('leaves out an archived member', async () => {
		await share(sam, 'home');
		await k.runner.invoke('core.archiveMember', { memberId: sam.memberId }, admin);
		expect((await presence()).people).toEqual([]);
	});

	it('asks once a minute', async () => {
		await share(sam, 'home');
		await presence();
		await presence();
		expect(personRequests()).toHaveLength(1);
		k.clock.advance(61_000);
		await presence();
		expect(personRequests()).toHaveLength(2);
	});

	it.each(['http_401', 'unreachable', 'timeout'] as const)(
		'shows nothing when Home Assistant answers %s, never what it said before',
		async (code) => {
			await share(sam, 'home');
			expect((await presence()).people).toHaveLength(1);
			k.http.serve(`${BASE}/api/states/person.sam`, new ExternalHttpError(code));
			k.clock.advance(61_000);
			expect(await presence()).toEqual({ people: [], status: 'unavailable' });
		},
	);

	it('says unknown for a person Home Assistant no longer has', async () => {
		k.http.serve(`${BASE}/api/states/person.sam`, new ExternalHttpError('http_404'));
		await share(sam, 'home');
		expect((await presence()).people).toEqual([
			{ memberId: sam.memberId, presence: { kind: 'unknown' }, since: null },
		]);
	});

	it('is not connected without a connection', async () => {
		await share(sam, 'home');
		await k.runner.invoke('homeassistant.disconnect', {}, admin);
		expect(await presence()).toEqual({ people: [], status: 'not_connected' });
	});
});

describe('the people Home Assistant has', () => {
	it('lists persons by id and name only, from the same read as the entities', async () => {
		k.http.serve(`${BASE}/api/states`, {
			text: JSON.stringify([
				personBody('person.sam', 'home'),
				personBody('person.alex', 'School'),
				{
					entity_id: 'sensor.outside',
					state: '12',
					attributes: { friendly_name: 'Outside' },
					last_changed: '2026-10-17T07:45:00+00:00',
				},
				{
					entity_id: 'device_tracker.sam_phone',
					state: 'home',
					attributes: { latitude: 52.3601, friendly_name: 'Phone' },
				},
			]),
		});
		await connect();
		const result: Persons = await k.route('homeassistant.listPersons').call({ actor: admin });
		expect(result).toEqual({
			status: 'ok',
			persons: [
				{ entityId: 'person.alex', name: 'alex' },
				{ entityId: 'person.sam', name: 'sam' },
			],
		});
		const entities = await k.route('homeassistant.findEntities').call({ actor: admin, query: {} });
		expect(entities.entities.map((e: { entityId: string }) => e.entityId)).toEqual([
			'sensor.outside',
		]);
		expect(k.http.requests.filter((r) => r.url === `${BASE}/api/states`)).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain('52.36');
	});
});
