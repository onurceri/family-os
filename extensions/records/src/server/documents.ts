import {
	defineAction,
	defineEvent,
	defineRoute,
	FamosError,
	FileResponseSchema,
	selfOf,
	type UnitOfWork,
} from '@famos/sdk';
import { z } from 'zod';
import {
	AttachDocumentSchema,
	DEFAULT_AUDIENCE,
	documentChangedPayload,
	RecordDocIdSchema,
	RecordDocumentSchema,
	RecordIdSchema,
	UpdateDocumentSchema,
} from '../contract/index.ts';
import { knownAudience, mayRead, paperAudience } from './area.ts';
import { recordsEdit, recordsView } from './capabilities.ts';
import { PAPER_KIND } from './search.ts';
import { type DocumentRow, tables, toDocument } from './store.ts';

export const documentChanged = defineEvent('records.document.changed', documentChangedPayload, {
	audience: (payload) => payload.audience ?? DEFAULT_AUDIENCE,
});

/** Tells the people who may see a record's papers that they changed. */
export async function emitDocumentChanged(uow: UnitOfWork, recordId: string, recordKind: string) {
	const audience = await paperAudience(tables(uow.db), recordId, recordKind);
	uow.emit(documentChanged, { recordId, audience: knownAudience(uow, audience) });
}

/**
 * Links files that arrived through the Inbox to a record. The file stays where the
 * Inbox stored it (`inbox/<item id>/<n>`); only files that exist can be linked. Needs
 * `records.edit` outright (no draft): the Inbox's "Add to…" must either file the papers or
 * refuse, and filing is the one path that keeps the AI from reading them.
 */
export const attachDocument = defineAction({
	id: 'records.attachDocument',
	title: 'Attach papers to a record',
	input: AttachDocumentSchema,
	output: z.array(RecordDocumentSchema),
	requires: recordsEdit.id,
	approval: 'never',
	async run(uow, input) {
		const db = tables(uow.db);
		const now = uow.clock.now();
		const result: DocumentRow[] = [];
		for (const file of input.files) {
			const existing = await db
				.selectFrom('records_documents')
				.selectAll()
				.where('record_id', '=', input.recordId)
				.where('file_key', '=', file.key)
				.executeTakeFirst();
			if (existing) {
				// Filing the same paper again is not an error; it also brings an archived one back.
				if (existing.archived_at !== null) {
					await db
						.updateTable('records_documents')
						.set({ archived_at: null, updated_at: now })
						.where('id', '=', existing.id)
						.execute();
				}
				await uow.ai.reindex(PAPER_KIND, existing.id);
				result.push({ ...existing, archived_at: null });
				continue;
			}
			const stat = await uow.files.stat(file.key);
			if (!stat) throw new FamosError('bad_request', `File not found: ${file.name}`);
			const row: DocumentRow = {
				id: uow.ids.next('record_doc'),
				record_id: input.recordId,
				record_kind: input.recordKind,
				file_key: file.key,
				name: file.name,
				type: file.type || stat.contentType || 'application/octet-stream',
				size: stat.size,
				label: input.label,
				expires_on: input.expiresOn ?? null,
				source_item_id: input.sourceItemId ?? null,
				created_by: selfOf(uow.actor),
				created_at: now,
				updated_at: now,
				archived_at: null,
			};
			await db.insertInto('records_documents').values(row).execute();
			await uow.ai.reindex(PAPER_KIND, row.id);
			result.push(row);
		}
		await emitDocumentChanged(uow, input.recordId, input.recordKind);
		return result.map(toDocument);
	},
});

export const updateDocument = defineAction({
	id: 'records.updateDocument',
	target: ({ id }) => ({ table: 'records_documents', id, liveColumn: 'archived_at' }),
	title: 'Change the label or expiry of a paper',
	draftTitle: 'records:draft_title_update_document',
	input: UpdateDocumentSchema,
	output: RecordDocumentSchema,
	approval: { unless: recordsEdit.id },
	async run(uow, { id, name, label, expiresOn }) {
		const db = tables(uow.db);
		const row = await db
			.selectFrom('records_documents')
			.selectAll()
			.where('id', '=', id)
			.where('archived_at', 'is', null)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', 'Document not found');
		const patch = {
			...(name !== undefined && { name }),
			...(label !== undefined && { label }),
			...(expiresOn !== undefined && { expires_on: expiresOn }),
			updated_at: uow.clock.now(),
		};
		await db.updateTable('records_documents').set(patch).where('id', '=', id).execute();
		await uow.ai.reindex(PAPER_KIND, id);
		await emitDocumentChanged(uow, row.record_id, row.record_kind);
		return toDocument({ ...row, ...patch });
	},
});

/** Takes the link away; the file itself stays with its Inbox item. */
export const detachDocument = defineAction({
	id: 'records.detachDocument',
	target: ({ id }) => ({ table: 'records_documents', id }),
	title: 'Detach a paper from a record',
	draftTitle: 'records:draft_title_detach_document',
	input: z.object({ id: RecordDocIdSchema }),
	output: z.object({ ok: z.literal(true) }),
	approval: { unless: recordsEdit.id },
	async run(uow, { id }) {
		const db = tables(uow.db);
		const row = await db
			.selectFrom('records_documents')
			.select(['record_id', 'record_kind'])
			.where('id', '=', id)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', 'Document not found');
		await db.deleteFrom('records_documents').where('id', '=', id).execute();
		await uow.ai.remove(PAPER_KIND, id);
		await emitDocumentChanged(uow, row.record_id, row.record_kind);
		return { ok: true as const };
	},
});

export const listDocuments = defineRoute({
	method: 'get',
	path: '/documents',
	operationId: 'records.listDocuments',
	summary: 'The papers attached to a record, newest first',
	requires: recordsView.id,
	query: z.object({ recordId: RecordIdSchema }),
	response: z.array(RecordDocumentSchema),
	async handle(ctx, { query, actor }) {
		const rows = await tables(ctx.db)
			.selectFrom('records_documents')
			.selectAll()
			.where('record_id', '=', query.recordId)
			.where('archived_at', 'is', null)
			.orderBy('created_at', 'desc')
			.orderBy('id', 'desc')
			.execute();
		const first = rows[0];
		if (!first) return [];
		const audience = await paperAudience(tables(ctx.db), query.recordId, first.record_kind);
		if (!mayRead((c) => ctx.access.can(actor, c), audience)) return [];
		return rows.map(toDocument);
	},
});

/** Only files linked to a record can be opened here, never an arbitrary key. */
export const getDocumentFile = defineRoute({
	method: 'get',
	path: '/documents/{documentId}/file',
	operationId: 'records.getDocumentFile',
	summary: 'A paper attached to a record (images and PDFs open inline)',
	requires: recordsView.id,
	params: z.object({ documentId: RecordDocIdSchema }),
	response: FileResponseSchema,
	async handle(ctx, { params, actor }) {
		const row = await tables(ctx.db)
			.selectFrom('records_documents')
			.selectAll()
			.where('id', '=', params.documentId)
			.where('archived_at', 'is', null)
			.executeTakeFirst();
		// A paper of an area the caller may not see answers like one that does not exist.
		const audience = row
			? await paperAudience(tables(ctx.db), row.record_id, row.record_kind)
			: DEFAULT_AUDIENCE;
		const stored =
			row && mayRead((c) => ctx.access.can(actor, c), audience)
				? await ctx.files.get(row.file_key)
				: null;
		if (!row || !stored) throw new FamosError('not_found', 'File not found');
		return {
			stream: stored.stream,
			contentType: row.type,
			size: stored.stat.size,
			filename: row.name,
		};
	},
});
