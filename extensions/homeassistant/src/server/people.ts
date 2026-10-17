import {
	type Actor,
	defineAction,
	defineRoute,
	type ExtensionContext,
	FamosError,
	isExternalHttpError,
	type UnitOfWork,
} from '@famos/sdk';
import { z } from 'zod';
import {
	LinkPersonInputSchema,
	type MySharing,
	MySharingSchema,
	type PersonLink,
	PersonLinkSchema,
	PersonLinksSchema,
	type PresenceList,
	PresenceListSchema,
	SetMySharingInputSchema,
	UnlinkPersonInputSchema,
} from '../contract/index.ts';
import { homeassistantManage, homeassistantPresence, peopleChanged } from './capabilities.ts';
import { type PersonState, readPerson, toPresence } from './presence.ts';
import { type HomeAssistantTables, tables } from './store.ts';
import {
	AT_ONCE,
	CACHE_MS,
	credentials,
	ENTITY_MAX_BYTES,
	ENTITY_TIMEOUT_MS,
	inParallel,
	memoryOf,
	once,
	request,
} from './values.ts';

/**
 * Who is home. An admin links a member to a Home Assistant person; nothing is shown until that
 * member chooses what to show about themselves (Settings → You), and only they can choose. A
 * display shows only those who also chose to be on family displays. Where someone is is read
 * live and kept for a minute in memory; it is never stored.
 */

type Row = HomeAssistantTables['homeassistant_people'];

/** Everyone may make choices about themselves (as with their language): it changes nothing for anyone else. */
const OWN_CHOICES = 'core.notifications.receive';

/** The most answers of `GET /presence` kept at once (one per kind of viewer, in practice). */
const PRESENCE_KEPT = 8;

const toLink = (row: Row): PersonLink => ({
	memberId: row.member_id,
	personEntity: row.person_entity as PersonLink['personEntity'],
	level: row.level,
	onDisplays: row.on_displays === 1,
});

export const loadPeople = (db: UnitOfWork['db']) =>
	tables(db).selectFrom('homeassistant_people').selectAll().orderBy('created_at').execute();

const findPerson = (db: UnitOfWork['db'], memberId: string) =>
	tables(db)
		.selectFrom('homeassistant_people')
		.selectAll()
		.where('member_id', '=', memberId)
		.executeTakeFirst();

export const linkPerson = defineAction({
	id: 'homeassistant.linkPerson',
	title: 'Link a member to a Home Assistant person',
	input: LinkPersonInputSchema,
	output: PersonLinkSchema,
	requires: homeassistantManage.id,
	approval: 'never',
	async run(uow, input) {
		const members = await uow.family.members();
		if (!members.some((m) => m.id === input.memberId))
			throw new FamosError('not_found', 'There is no such member');
		const db = tables(uow.db);
		const taken = await db
			.selectFrom('homeassistant_people')
			.select('member_id')
			.where('person_entity', '=', input.personEntity)
			.executeTakeFirst();
		if (taken && taken.member_id !== input.memberId)
			throw new FamosError('conflict', 'That person is linked to another member');
		const current = await findPerson(uow.db, input.memberId);
		// Linked to this person already: the member's choice stays as they made it.
		if (current?.person_entity === input.personEntity) return toLink(current);
		const now = uow.clock.now();
		// Someone else in Home Assistant: what the member chose was about the other one, so it
		// starts again from nothing.
		const fresh = {
			person_entity: input.personEntity,
			level: 'none' as const,
			on_displays: 0,
			updated_at: now,
		};
		if (current)
			await db
				.updateTable('homeassistant_people')
				.set(fresh)
				.where('member_id', '=', input.memberId)
				.execute();
		else
			await db
				.insertInto('homeassistant_people')
				.values({ member_id: input.memberId, ...fresh, created_at: now })
				.execute();
		uow.emit(peopleChanged, {});
		return toLink((await findPerson(uow.db, input.memberId)) as Row);
	},
});

export const unlinkPerson = defineAction({
	id: 'homeassistant.unlinkPerson',
	title: 'Unlink a member from their Home Assistant person',
	input: UnlinkPersonInputSchema,
	output: z.object({ ok: z.literal(true) }),
	requires: homeassistantManage.id,
	approval: 'never',
	async run(uow, input) {
		const done = await tables(uow.db)
			.deleteFrom('homeassistant_people')
			.where('member_id', '=', input.memberId)
			.executeTakeFirst();
		if (Number(done.numDeletedRows) > 0) uow.emit(peopleChanged, {});
		return { ok: true as const };
	},
});

export const setMySharing = defineAction({
	id: 'homeassistant.setMySharing',
	title: 'Choose what FamilyOS shows about where I am',
	input: SetMySharingInputSchema,
	output: MySharingSchema,
	requires: OWN_CHOICES,
	approval: 'never',
	// Only the person decides what is shown about where they are: no suggestion of it, by anyone.
	refuseProposal: async () => 'Only the person can choose what is shown about where they are.',
	async run(uow, input) {
		if (uow.actor.kind !== 'member')
			throw new FamosError('forbidden', 'Only the person can choose what is shown about them');
		const memberId = uow.actor.memberId;
		const row = await findPerson(uow.db, memberId);
		if (!row) throw new FamosError('not_found', 'You are not linked to a Home Assistant person');
		// Nothing shown means nothing on displays either; choosing again starts with it off.
		const onDisplays = input.level !== 'none' && input.onDisplays ? 1 : 0;
		await tables(uow.db)
			.updateTable('homeassistant_people')
			.set({ level: input.level, on_displays: onDisplays, updated_at: uow.clock.now() })
			.where('member_id', '=', memberId)
			.execute();
		uow.emit(peopleChanged, {});
		return { linked: true as const, level: input.level, onDisplays: onDisplays === 1 };
	},
});

export const listPeople = defineRoute({
	method: 'get',
	path: '/people',
	operationId: 'homeassistant.listPeople',
	summary: 'Which members are linked to which Home Assistant person, and what each chose to show',
	requires: homeassistantManage.id,
	response: PersonLinksSchema,
	async handle(ctx) {
		return { links: (await loadPeople(ctx.db)).map(toLink) };
	},
});

export const getMySharing = defineRoute({
	method: 'get',
	path: '/people/me',
	operationId: 'homeassistant.getMySharing',
	summary: 'What the signed-in member chose to show about where they are',
	requires: 'signedIn',
	response: MySharingSchema,
	async handle(ctx, { actor }): Promise<MySharing> {
		if (actor.kind !== 'member') return { linked: false };
		const row = await findPerson(ctx.db, actor.memberId);
		return row
			? { linked: true, level: row.level, onDisplays: row.on_displays === 1 }
			: { linked: false };
	},
});

/** The people this viewer may see: they chose to show something, and a display only those on displays. */
async function shownTo(ctx: ExtensionContext, actor: Actor): Promise<Row[]> {
	const active = new Set((await ctx.family.members()).map((m) => m.id));
	return (await loadPeople(ctx.db)).filter(
		(row) =>
			row.level !== 'none' &&
			active.has(row.member_id) &&
			(actor.kind !== 'display' || row.on_displays === 1),
	);
}

async function readPresence(
	ctx: ExtensionContext,
	baseUrl: string,
	token: string,
	rows: readonly Row[],
): Promise<PresenceList> {
	const found = new Map<string, PersonState | null>();
	try {
		await inParallel(rows, AT_ONCE, async (row) => {
			try {
				const response = await ctx.http.get(
					request(
						baseUrl,
						token,
						`/api/states/${row.person_entity}`,
						ENTITY_TIMEOUT_MS,
						ENTITY_MAX_BYTES,
					),
				);
				let person: PersonState | null = null;
				if (response.status === 200) {
					try {
						person = readPerson(JSON.parse(response.text));
					} catch {
						person = null;
					}
				}
				// Asked for this person and got another one: nothing to trust.
				found.set(row.member_id, person?.entityId === row.person_entity ? person : null);
			} catch (error) {
				// A person Home Assistant does not have (any more): where they are is not known.
				if (isExternalHttpError(error) && error.code === 'http_404') found.set(row.member_id, null);
				else throw error;
			}
		});
	} catch (error) {
		// A refused token, an unreachable or broken Home Assistant: nothing is current, show nothing.
		ctx.logger.info(
			{ code: isExternalHttpError(error) ? error.code : 'failed' },
			'home assistant presence unavailable',
		);
		return { people: [], status: 'unavailable' };
	}
	return {
		status: 'ok',
		people: rows.map((row) => {
			const person = found.get(row.member_id) ?? null;
			const level = row.level === 'place' ? 'place' : 'home';
			const presence = toPresence(person, level);
			return {
				memberId: row.member_id,
				presence,
				since: presence.kind === 'unknown' ? null : (person?.since ?? null),
			};
		}),
	};
}

export const getPresence = defineRoute({
	method: 'get',
	path: '/presence',
	operationId: 'homeassistant.getPresence',
	summary:
		'Who is home, as much as each linked person chose to show (read live, cached for a minute)',
	requires: homeassistantPresence.id,
	response: PresenceListSchema,
	async handle(ctx, { actor }) {
		const connection = await credentials(ctx);
		if (!connection) return { people: [], status: 'not_connected' as const };
		if (connection.token === null) return { people: [], status: 'not_connected' as const };
		// Who may be shown is decided before anything is read: nobody else is asked about.
		const rows = await shownTo(ctx, actor);
		if (rows.length === 0) return { people: [], status: 'ok' as const };
		const memory = memoryOf(ctx);
		// A changed choice or connection makes a new key, so it is honoured at once.
		const key = JSON.stringify([
			connection.stamp,
			rows.map((r) => [r.member_id, r.person_entity, r.level, r.on_displays]),
		]);
		const now = ctx.clock.now();
		const hit = memory.presence.get(key);
		if (hit && now - hit.at >= 0 && now - hit.at < CACHE_MS) return hit.value;
		const { baseUrl, token } = connection;
		const value = await once(memory, `presence:${key}`, () =>
			readPresence(ctx, baseUrl, token, rows),
		);
		memory.presence.delete(key);
		memory.presence.set(key, { key, at: ctx.clock.now(), value });
		for (const old of memory.presence.keys()) {
			if (memory.presence.size <= PRESENCE_KEPT) break;
			memory.presence.delete(old);
		}
		return value;
	},
});
