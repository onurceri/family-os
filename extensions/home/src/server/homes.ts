import { type AddObligationInput, scheduleOf } from '@famos/ext-records/contract';
import { defineAction, defineRoute, FamosError } from '@famos/sdk';
import { z } from 'zod';
import {
	AddHomeSchema,
	HOME_AUDIENCE,
	HOME_KIND,
	HOME_PRESETS,
	type HomeFieldsSchema,
	HomeIdSchema,
	HomeSchema,
	homeUrl,
	UpdateHomeSchema,
} from '../contract/index.ts';
import { homeEdit, homeView } from './capabilities.ts';
import { ITEM_SEARCH_KIND, SERVICE_SEARCH_KIND } from './search.ts';
import { homeChanged, loadHome, memberId } from './shared.ts';
import { tables, toHome } from './store.ts';

const fieldsOf = (h: z.output<typeof HomeFieldsSchema>) => ({
	name: h.name,
	address: h.address,
	tenure: h.tenure,
	notes: h.notes || null,
});

export const addHome = defineAction({
	id: 'home.addHome',
	title: 'Add a home',
	draftTitle: 'home:draft_title_add_home',
	input: AddHomeSchema,
	output: HomeSchema,
	approval: { unless: homeEdit.id },
	async alreadyThere(ctx, input) {
		const row = await tables(ctx.db)
			.selectFrom('home_homes')
			.select('id')
			.where('archived_at', 'is', null)
			.where('name', '=', input.name)
			.executeTakeFirst();
		return row !== undefined;
	},
	async run(uow, { obligations, ...input }) {
		const now = uow.clock.now();
		const row = {
			id: uow.ids.next('home'),
			...fieldsOf(input),
			created_by: memberId(uow.actor),
			created_at: now,
			updated_at: now,
			archived_at: null,
		};
		await tables(uow.db).insertInto('home_homes').values(row).execute();
		// What usually needs doing, as picked: the repeat and lead time are the person's, the preset only suggests them.
		for (const pick of obligations) {
			const preset = HOME_PRESETS.find((p) => p.id === pick.preset);
			if (!preset) throw new FamosError('bad_request', `Unknown preset: ${pick.preset}`);
			const obligation: AddObligationInput = {
				recordId: row.id,
				recordKind: HOME_KIND,
				recordName: row.name,
				recordUrl: homeUrl(row.id),
				kind: preset.id,
				title: pick.title,
				dueDate: pick.dueDate,
				...scheduleOf(preset, pick),
				audience: HOME_AUDIENCE,
			};
			await uow.run('records.addObligation', obligation);
		}
		uow.emit(homeChanged, { homeId: row.id });
		return toHome(row);
	},
});

export const updateHome = defineAction({
	id: 'home.updateHome',
	title: 'Change a home',
	draftTitle: 'home:draft_title_update_home',
	input: UpdateHomeSchema,
	output: HomeSchema,
	approval: { unless: homeEdit.id },
	async run(uow, { id, home }) {
		const row = await loadHome(uow, id);
		const patch = { ...fieldsOf(home), updated_at: uow.clock.now() };
		await tables(uow.db).updateTable('home_homes').set(patch).where('id', '=', id).execute();
		// Lists that span records ("Coming up", reminders) show the name.
		if (patch.name !== row.name) {
			await uow.run('records.renameRecord', { recordId: id, name: patch.name, url: homeUrl(id) });
		}
		uow.emit(homeChanged, { homeId: id });
		return toHome({ ...row, ...patch });
	},
});

/**
 * Hides the home, its things and its services together with their obligations and papers (kept,
 * no more reminders).
 */
export const archiveHome = defineAction({
	id: 'home.archiveHome',
	title: 'Archive a home',
	draftTitle: 'home:draft_title_archive_home',
	input: z.object({ id: HomeIdSchema }),
	output: z.object({ ok: z.literal(true) }),
	approval: { unless: homeEdit.id },
	async run(uow, { id }) {
		await loadHome(uow, id);
		const now = uow.clock.now();
		const db = tables(uow.db);
		const items = await db
			.selectFrom('home_items')
			.select('id')
			.where('home_id', '=', id)
			.where('archived_at', 'is', null)
			.execute();
		const services = await db
			.selectFrom('home_services')
			.select('id')
			.where('home_id', '=', id)
			.where('archived_at', 'is', null)
			.execute();
		const archived = { archived_at: now, updated_at: now };
		await db
			.updateTable('home_items')
			.set(archived)
			.where('home_id', '=', id)
			.where('archived_at', 'is', null)
			.execute();
		await db
			.updateTable('home_services')
			.set(archived)
			.where('home_id', '=', id)
			.where('archived_at', 'is', null)
			.execute();
		await db.updateTable('home_homes').set(archived).where('id', '=', id).execute();
		for (const recordId of [id, ...items.map((i) => i.id), ...services.map((s) => s.id)]) {
			await uow.run('records.archiveForRecord', { recordId });
		}
		for (const item of items) await uow.ai.remove(ITEM_SEARCH_KIND, item.id);
		for (const service of services) await uow.ai.remove(SERVICE_SEARCH_KIND, service.id);
		uow.emit(homeChanged, { homeId: id });
		return { ok: true as const };
	},
});

export const listHomes = defineRoute({
	method: 'get',
	path: '/homes',
	operationId: 'home.listHomes',
	summary: 'The household’s homes',
	requires: homeView.id,
	response: z.array(HomeSchema),
	async handle(ctx) {
		const rows = await tables(ctx.db)
			.selectFrom('home_homes')
			.selectAll()
			.where('archived_at', 'is', null)
			.orderBy('created_at')
			.orderBy('id')
			.execute();
		return rows.map(toHome);
	},
});

export const getHome = defineRoute({
	method: 'get',
	path: '/homes/{homeId}',
	operationId: 'home.getHome',
	summary: 'One home',
	requires: homeView.id,
	params: z.object({ homeId: HomeIdSchema }),
	response: HomeSchema,
	async handle(ctx, { params }) {
		const row = await tables(ctx.db)
			.selectFrom('home_homes')
			.selectAll()
			.where('id', '=', params.homeId)
			.where('archived_at', 'is', null)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', 'Home not found');
		return toHome(row);
	},
});
