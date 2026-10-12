import { defineAction, defineRoute, FamosError, type UnitOfWork } from '@famos/sdk';
import { z } from 'zod';
import {
	AddServiceSchema,
	HomeIdSchema,
	ServiceIdSchema,
	ServiceSchema,
	serviceUrl,
	UpdateServiceSchema,
} from '../contract/index.ts';
import { homeEdit, homeView } from './capabilities.ts';
import { SERVICE_SEARCH_KIND } from './search.ts';
import { homeChanged, loadHome, memberId } from './shared.ts';
import { type ServiceRow, tables, toService } from './store.ts';

async function loadService(uow: UnitOfWork, id: string): Promise<ServiceRow> {
	const row = await tables(uow.db)
		.selectFrom('home_services')
		.selectAll()
		.where('id', '=', id)
		.where('archived_at', 'is', null)
		.executeTakeFirst();
	if (!row) throw new FamosError('not_found', 'Service not found');
	return row;
}

const fieldsOf = (s: z.output<typeof UpdateServiceSchema>['service']) => ({
	kind: s.kind,
	provider: s.provider,
	account_number: s.accountNumber || null,
	due_day: s.dueDay ?? null,
	notes: s.notes || null,
});

/**
 * Services (electricity, internet, dues…): who the household pays and under which account. The
 * billing day is informational: there are no amounts and no "paid".
 */
export const addService = defineAction({
	id: 'home.addService',
	title: 'Add a utility or subscription',
	draftTitle: 'home:draft_title_add_service',
	input: AddServiceSchema,
	output: ServiceSchema,
	approval: { unless: homeEdit.id },
	async alreadyThere(ctx, input) {
		const row = await tables(ctx.db)
			.selectFrom('home_services')
			.select('id')
			.where('home_id', '=', input.homeId)
			.where('archived_at', 'is', null)
			.where('kind', '=', input.kind)
			.where('provider', '=', input.provider)
			.executeTakeFirst();
		return row !== undefined;
	},
	async run(uow, { homeId, ...input }) {
		await loadHome(uow, homeId);
		const now = uow.clock.now();
		const row: ServiceRow = {
			id: uow.ids.next('home_service'),
			home_id: homeId,
			...fieldsOf(input),
			created_by: memberId(uow.actor),
			created_at: now,
			updated_at: now,
			archived_at: null,
		};
		await tables(uow.db).insertInto('home_services').values(row).execute();
		await uow.ai.reindex(SERVICE_SEARCH_KIND, row.id);
		uow.emit(homeChanged, { homeId });
		return toService(row);
	},
});

export const updateService = defineAction({
	id: 'home.updateService',
	title: 'Change a utility or subscription',
	draftTitle: 'home:draft_title_update_service',
	input: UpdateServiceSchema,
	output: ServiceSchema,
	approval: { unless: homeEdit.id },
	async run(uow, { id, service }) {
		const row = await loadService(uow, id);
		const patch = { ...fieldsOf(service), updated_at: uow.clock.now() };
		await tables(uow.db).updateTable('home_services').set(patch).where('id', '=', id).execute();
		await uow.ai.reindex(SERVICE_SEARCH_KIND, id);
		// A service is known by its provider in lists that span records.
		if (patch.provider !== row.provider) {
			await uow.run('records.renameRecord', {
				recordId: id,
				name: patch.provider,
				url: serviceUrl(id),
			});
		}
		uow.emit(homeChanged, { homeId: row.home_id });
		return toService({ ...row, ...patch });
	},
});

/** Hides the service and its obligations and papers (kept, no more reminders). */
export const archiveService = defineAction({
	id: 'home.archiveService',
	title: 'Archive a utility or subscription',
	draftTitle: 'home:draft_title_archive_service',
	input: z.object({ id: ServiceIdSchema }),
	output: z.object({ ok: z.literal(true) }),
	approval: { unless: homeEdit.id },
	async run(uow, { id }) {
		const row = await loadService(uow, id);
		const now = uow.clock.now();
		await tables(uow.db)
			.updateTable('home_services')
			.set({ archived_at: now, updated_at: now })
			.where('id', '=', id)
			.execute();
		await uow.run('records.archiveForRecord', { recordId: id });
		await uow.ai.remove(SERVICE_SEARCH_KIND, id);
		uow.emit(homeChanged, { homeId: row.home_id });
		return { ok: true as const };
	},
});

export const listServices = defineRoute({
	method: 'get',
	path: '/services',
	operationId: 'home.listServices',
	summary: 'The utilities and subscriptions of the household’s homes, optionally of one home',
	requires: homeView.id,
	query: z.object({ homeId: HomeIdSchema.optional() }),
	response: z.array(ServiceSchema),
	async handle(ctx, { query }) {
		let q = tables(ctx.db).selectFrom('home_services').selectAll().where('archived_at', 'is', null);
		if (query.homeId) q = q.where('home_id', '=', query.homeId);
		return (await q.orderBy('created_at').orderBy('id').execute()).map(toService);
	},
});

export const getService = defineRoute({
	method: 'get',
	path: '/services/{serviceId}',
	operationId: 'home.getService',
	summary: 'One utility or subscription',
	requires: homeView.id,
	params: z.object({ serviceId: ServiceIdSchema }),
	response: ServiceSchema,
	async handle(ctx, { params }) {
		const row = await tables(ctx.db)
			.selectFrom('home_services')
			.selectAll()
			.where('id', '=', params.serviceId)
			.where('archived_at', 'is', null)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', 'Service not found');
		return toService(row);
	},
});
