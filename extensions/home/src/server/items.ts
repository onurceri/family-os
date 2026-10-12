import { type AddObligationInput, scheduleOf } from '@famos/ext-records/contract';
import { defineAction, defineRoute, FamosError, type UnitOfWork } from '@famos/sdk';
import { z } from 'zod';
import {
	AddItemSchema,
	HOME_AUDIENCE,
	HomeIdSchema,
	ITEM_KIND,
	ITEM_PRESETS,
	ItemIdSchema,
	ItemSchema,
	itemUrl,
	UpdateItemSchema,
	WARRANTY_KIND,
	WARRANTY_LEAD_DAYS,
} from '../contract/index.ts';
import { homeEdit, homeView } from './capabilities.ts';
import { ITEM_SEARCH_KIND } from './search.ts';
import { homeChanged, loadHome, memberId } from './shared.ts';
import { type ItemRow, tables, toItem } from './store.ts';

async function loadItem(uow: UnitOfWork, id: string): Promise<ItemRow> {
	const row = await tables(uow.db)
		.selectFrom('home_items')
		.selectAll()
		.where('id', '=', id)
		.where('archived_at', 'is', null)
		.executeTakeFirst();
	if (!row) throw new FamosError('not_found', 'Thing not found');
	return row;
}

/**
 * Keeps the "Warranty ends" date in step with `warranty_until`: made when a date appears, moved
 * when it changes, removed when it goes. It lapses: a warranty ending asks nothing of anyone, so
 * it is never late and leaves Today once its day has passed. Saving the thing with the same date
 * says so again, which turns a date that was kept as a duty back into one that lapses. If it was
 * finished or removed by hand, a later, different date makes a new one (`records` refuses to
 * move the old one before it writes anything). Returns its id.
 */
async function syncWarranty(
	uow: UnitOfWork,
	item: { id: string; name: string },
	before: { until: string | null; obligationId: string | null },
	until: string | null,
): Promise<string | null> {
	const { obligationId } = before;
	if (before.until === until) {
		if (until !== null && obligationId) await keepLapsing(uow, obligationId, until);
		return obligationId;
	}
	if (until === null) {
		if (obligationId) {
			try {
				await uow.run('records.removeObligation', { id: obligationId });
			} catch (error) {
				if (!(error instanceof FamosError)) throw error;
			}
		}
		return null;
	}
	const { locale } = await uow.family.settings();
	const fields = {
		kind: WARRANTY_KIND,
		// Stored as the title, in the family language (English when it has no pack).
		title: uow.translate(locale, 'home:warranty_ends_title'),
		dueDate: until,
		every: null,
		leadDays: WARRANTY_LEAD_DAYS,
		audience: HOME_AUDIENCE,
		lapses: true,
	};
	if (obligationId) {
		try {
			const moved = await uow.run<unknown, { id: string }>('records.updateObligation', {
				id: obligationId,
				obligation: fields,
			});
			return moved.id;
		} catch (error) {
			if (!(error instanceof FamosError)) throw error;
			// Finished or removed since: the new date is a new duty.
		}
	}
	const input: AddObligationInput = {
		...fields,
		recordId: item.id,
		recordKind: ITEM_KIND,
		recordName: item.name,
		recordUrl: itemUrl(item.id),
	};
	return (await uow.run<unknown, { id: string }>('records.addObligation', input)).id;
}

/**
 * Says again that the warranty date lapses, leaving the lead time, the assignee and the notes as
 * they are. A date finished or removed by hand stays so.
 */
async function keepLapsing(uow: UnitOfWork, obligationId: string, until: string) {
	const { locale } = await uow.family.settings();
	try {
		await uow.run('records.updateObligation', {
			id: obligationId,
			obligation: {
				title: uow.translate(locale, 'home:warranty_ends_title'),
				dueDate: until,
				lapses: true,
			},
		});
	} catch (error) {
		if (!(error instanceof FamosError)) throw error;
	}
}

export const addItem = defineAction({
	id: 'home.addItem',
	title: 'Add a thing to a home',
	draftTitle: 'home:draft_title_add_item',
	input: AddItemSchema,
	output: ItemSchema,
	approval: { unless: homeEdit.id },
	undo: (item) => ({ actionId: 'home.archiveItem', input: { id: item.id } }),
	ai: {
		description:
			'Add something the household owns (an appliance, electronics, furniture) to a home from a receipt, an invoice or a warranty card: what was bought, its brand and model, the purchase date and when the warranty ends. Choose it when the shared item shows a purchase of a durable thing. If the thing is already listed (home_item:N), use home.updateItem instead.',
		guidance:
			'homeId is the home handle from the household records (for example home:1); never invent one, and propose nothing when no home is listed. name is what the thing is in a few words ("Washing machine"). brand and model as printed. purchasedOn is the purchase or invoice date. warrantyUntil is the last day of the warranty when the document says so (or the purchase date plus the stated warranty period); omit it when unknown. room only if the document says where it goes. Do not copy serial numbers into notes and do not put amounts of money anywhere. homeName is the home as listed.',
	},
	async alreadyThere(ctx, input) {
		const row = await tables(ctx.db)
			.selectFrom('home_items')
			.select('id')
			.where('home_id', '=', input.homeId)
			.where('archived_at', 'is', null)
			.where('name', '=', input.name)
			.where('brand', '=', input.brand)
			.where('model', '=', input.model)
			.executeTakeFirst();
		return row !== undefined;
	},
	async run(uow, { obligations, homeName: _homeName, ...input }) {
		await loadHome(uow, input.homeId);
		const now = uow.clock.now();
		const row: ItemRow = {
			id: uow.ids.next('home_item'),
			home_id: input.homeId,
			name: input.name,
			room: input.room,
			brand: input.brand,
			model: input.model,
			serial: input.serial || null,
			purchased_on: input.purchasedOn ?? null,
			warranty_until: input.warrantyUntil ?? null,
			warranty_obligation_id: null,
			notes: input.notes || null,
			created_by: memberId(uow.actor),
			created_at: now,
			updated_at: now,
			archived_at: null,
		};
		for (const pick of obligations) {
			const preset = ITEM_PRESETS.find((p) => p.id === pick.preset);
			if (!preset) throw new FamosError('bad_request', `Unknown preset: ${pick.preset}`);
		}
		await tables(uow.db).insertInto('home_items').values(row).execute();
		await uow.ai.reindex(ITEM_SEARCH_KIND, row.id);
		for (const pick of obligations) {
			const preset = ITEM_PRESETS.find((p) => p.id === pick.preset);
			if (!preset) continue;
			const obligation: AddObligationInput = {
				recordId: row.id,
				recordKind: ITEM_KIND,
				recordName: row.name,
				recordUrl: itemUrl(row.id),
				kind: preset.id,
				title: pick.title,
				dueDate: pick.dueDate,
				...scheduleOf(preset, pick),
				audience: HOME_AUDIENCE,
			};
			await uow.run('records.addObligation', obligation);
		}
		if (row.warranty_until) {
			row.warranty_obligation_id = await syncWarranty(
				uow,
				row,
				{ until: null, obligationId: null },
				row.warranty_until,
			);
			await tables(uow.db)
				.updateTable('home_items')
				.set({ warranty_obligation_id: row.warranty_obligation_id })
				.where('id', '=', row.id)
				.execute();
		}
		uow.emit(homeChanged, { homeId: row.home_id });
		return toItem(row);
	},
});

export const updateItem = defineAction({
	id: 'home.updateItem',
	title: 'Change a thing',
	draftTitle: 'home:draft_title_update_item',
	input: UpdateItemSchema,
	// The old values of the fields that were given, keyed like the input (for undo).
	output: ItemSchema.extend({ before: UpdateItemSchema.omit({ id: true, itemName: true }) }),
	approval: { unless: homeEdit.id },
	undo: ({ id, before }) => ({ actionId: 'home.updateItem', input: { id, ...before } }),
	ai: {
		description:
			'Change what is known about a listed thing (home_item:N), for example when the warranty was extended or a model or purchase date is printed on a document. Choose it when the shared item is about a thing that is already in the household records.',
		guidance:
			'id is the thing handle from the household records (for example home_item:2); never invent one. Give only the fields that the document states and leave every other field out: a field left out stays as it is. warrantyUntil is the new last day of the warranty (for an extension: the new end date). Do not put amounts of money or serial numbers in notes. itemName is the thing as listed.',
	},
	async run(uow, { id, itemName: _itemName, ...given }) {
		const row = await loadItem(uow, id);
		const patch = {
			name: given.name ?? row.name,
			room: given.room ?? row.room,
			brand: given.brand ?? row.brand,
			model: given.model ?? row.model,
			serial: given.serial === undefined ? row.serial : given.serial || null,
			purchased_on: given.purchasedOn === undefined ? row.purchased_on : given.purchasedOn,
			warranty_until: given.warrantyUntil === undefined ? row.warranty_until : given.warrantyUntil,
			notes: given.notes === undefined ? row.notes : given.notes || null,
			updated_at: uow.clock.now(),
		};
		const obligationId = await syncWarranty(
			uow,
			{ id, name: patch.name },
			{ until: row.warranty_until, obligationId: row.warranty_obligation_id },
			patch.warranty_until,
		);
		await tables(uow.db)
			.updateTable('home_items')
			.set({ ...patch, warranty_obligation_id: obligationId })
			.where('id', '=', id)
			.execute();
		await uow.ai.reindex(ITEM_SEARCH_KIND, id);
		if (patch.name !== row.name) {
			await uow.run('records.renameRecord', {
				recordId: id,
				name: patch.name,
				url: itemUrl(id),
			});
		}
		uow.emit(homeChanged, { homeId: row.home_id });
		const old = toItem(row);
		const before = Object.fromEntries(
			Object.entries(given)
				.filter(([, value]) => value !== undefined)
				.map(([key]) => [key, old[key as keyof typeof given]]),
		);
		return { ...toItem({ ...row, ...patch, warranty_obligation_id: obligationId }), before };
	},
});

/** Hides the thing and its obligations and papers (kept, no more reminders). */
export const archiveItem = defineAction({
	id: 'home.archiveItem',
	title: 'Archive a thing',
	draftTitle: 'home:draft_title_archive_item',
	input: z.object({ id: ItemIdSchema }),
	output: z.object({ ok: z.literal(true) }),
	approval: { unless: homeEdit.id },
	async run(uow, { id }) {
		const row = await loadItem(uow, id);
		const now = uow.clock.now();
		await tables(uow.db)
			.updateTable('home_items')
			.set({ archived_at: now, updated_at: now })
			.where('id', '=', id)
			.execute();
		await uow.run('records.archiveForRecord', { recordId: id });
		await uow.ai.remove(ITEM_SEARCH_KIND, id);
		uow.emit(homeChanged, { homeId: row.home_id });
		return { ok: true as const };
	},
});

export const listItems = defineRoute({
	method: 'get',
	path: '/items',
	operationId: 'home.listItems',
	summary: 'The things in the household’s homes, optionally of one home',
	requires: homeView.id,
	query: z.object({ homeId: HomeIdSchema.optional() }),
	response: z.array(ItemSchema),
	async handle(ctx, { query }) {
		let q = tables(ctx.db).selectFrom('home_items').selectAll().where('archived_at', 'is', null);
		if (query.homeId) q = q.where('home_id', '=', query.homeId);
		return (await q.orderBy('created_at').orderBy('id').execute()).map(toItem);
	},
});

export const getItem = defineRoute({
	method: 'get',
	path: '/items/{itemId}',
	operationId: 'home.getItem',
	summary: 'One thing',
	requires: homeView.id,
	params: z.object({ itemId: ItemIdSchema }),
	response: ItemSchema,
	async handle(ctx, { params }) {
		const row = await tables(ctx.db)
			.selectFrom('home_items')
			.selectAll()
			.where('id', '=', params.itemId)
			.where('archived_at', 'is', null)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', 'Thing not found');
		return toItem(row);
	},
});
