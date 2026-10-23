import type { AiIndex } from '@famos/sdk';
import { paperAudience } from './area.ts';
import { recordsView } from './capabilities.ts';
import { tables } from './store.ts';

export const OBLIGATION_KIND = 'records.obligation';
export const PAPER_KIND = 'records.paper';

const PAGE = 100;

/**
 * What family search reads of the records: what needs doing (title, record, notes)
 * and the papers filed on a record (file name, label, record). A paper's own text is not
 * indexed: filing keeps the AI from reading the file, and the file itself
 * stays with its Inbox item. An obligation names the capability of its area as its audience, and
 * search honours that like the AI context does.
 */
export const searchIndex: AiIndex = {
	kinds: {
		[OBLIGATION_KIND]: {
			capability: recordsView.id,
			async load(ctx, id) {
				const row = await tables(ctx.db)
					.selectFrom('records_obligations')
					.selectAll()
					.where('id', '=', id)
					.where('archived_at', 'is', null)
					.executeTakeFirst();
				if (!row) return null;
				const text = [row.record_name, row.notes].filter((part): part is string => Boolean(part));
				return {
					title: row.title,
					text: text.join('\n'),
					href: row.record_url ?? '/',
					capability: row.audience,
				};
			},
		},
		[PAPER_KIND]: {
			capability: recordsView.id,
			async load(ctx, id) {
				const row = await tables(ctx.db)
					.selectFrom('records_documents')
					.selectAll()
					.where('id', '=', id)
					.where('archived_at', 'is', null)
					.executeTakeFirst();
				if (!row) return null;
				// The record's name and page live on its duties, and a rename reaches all of them
				// (archived ones too), so any one is current.
				const record = await tables(ctx.db)
					.selectFrom('records_obligations')
					.select(['record_name', 'record_url'])
					.where('record_id', '=', row.record_id)
					.orderBy('id', 'desc')
					.executeTakeFirst();
				const text = [row.label, record?.record_name].filter((part): part is string =>
					Boolean(part),
				);
				return {
					title: row.name,
					text: text.join('\n'),
					href: record?.record_url ?? '/',
					capability: await paperAudience(tables(ctx.db), row.record_id, row.record_kind),
				};
			},
		},
	},
	/** Cursor: `<kind>:<last id>`; obligations first, then papers. */
	async list(ctx, cursor) {
		const [phase, after] = cursor?.split(':', 2) ?? [];
		const kind = phase === PAPER_KIND ? PAPER_KIND : OBLIGATION_KIND;
		const table = kind === OBLIGATION_KIND ? 'records_obligations' : 'records_documents';
		let q = tables(ctx.db)
			.selectFrom(table)
			.select('id')
			.where('archived_at', 'is', null)
			.orderBy('id')
			.limit(PAGE);
		if (kind === phase && after) q = q.where('id', '>', after);
		const rows = await q.execute();
		const items = rows.map((r) => ({ kind, id: r.id }));
		if (rows.length === PAGE) return { items, next: `${kind}:${rows.at(-1)?.id}` };
		return { items, next: kind === OBLIGATION_KIND ? `${PAPER_KIND}:` : null };
	},
};
