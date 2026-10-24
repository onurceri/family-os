import {
	type Actor,
	defineAction,
	defineCapability,
	defineEvent,
	defineRoute,
	type ExtensionContext,
	FamosError,
	FileResponseSchema,
	isFamosError,
	MalformedImageError,
	personPresent,
	type ShareTarget,
	STRIPPED_TYPES,
	selfOf,
	stripImageMetadata,
	type UnitOfWork,
	type UploadedFile,
} from '@famos/sdk';
import { z } from 'zod';
import {
	ChannelSchema,
	type FileTo,
	FileToSchema,
	InboxItemIdSchema,
	InboxItemSchema,
	itemChangedPayload,
	NewItemFieldsSchema,
	UPLOAD_LIMITS,
	UPLOAD_QUOTA,
} from '../contract/index.ts';
import { filesOf, ITEM_KIND, type StoredFile, tables, toItem } from './store.ts';

/** An item is its sender's own (others see it only through a suggestion), so only they hear of it. */
export const itemChanged = defineEvent('inbox.item.changed', itemChangedPayload, {
	audience: (payload) => (payload.memberId ? { member: payload.memberId } : []),
});
export const PROCESS_JOB = 'inbox.process';

/** What the Inbox protects: sharing into it. */
export const inboxShare = defineCapability({
	id: 'inbox.share',
	label: 'inbox:cap_share',
	level: 'use',
});

/**
 * Items are personal: only the person who shared one changes it (dismiss, read again,
 * file). Background work (the system actor) is not a person and may do all of it.
 */
const mayHandle = (actor: Actor, createdBy: string | null) =>
	(selfOf(actor) !== null && createdBy === selfOf(actor)) || actor.kind === 'system';

/**
 * Items a member may see although they did not share them: those with a suggestion waiting that
 * they may decide (addressed to them, or one they could approve as an approver).
 */
async function decidableItemIds(ctx: ExtensionContext, actor: Actor): Promise<string[]> {
	if (!personPresent(actor)) return [];
	const result = await ctx.actions.invoke<{ sourceIds: string[] }>(
		'core.decidableSources',
		{ sourceKind: 'inbox' },
		actor,
	);
	return result.status === 'applied' ? result.output.sourceIds : [];
}

const StoredFileSchema = z.object({
	key: z.string(),
	name: z.string().max(255),
	type: z.string().max(100),
	size: z.number().int().nonnegative(),
});

/**
 * Puts an item's files on a record through the records extension, inside the caller's
 * transaction: if records refuses (no `records.edit`, a file is missing, records is off), the
 * whole change is rolled back. Records is reached by action id only.
 */
async function fileOnRecord(
	uow: UnitOfWork,
	itemId: string,
	files: readonly { key: string; name: string; type: string }[],
	fileTo: FileTo,
) {
	// Records reads the files where they are; it may only once the Inbox lets it.
	for (const { key } of files) await uow.files.grant(key, 'records');
	try {
		await uow.run('records.attachDocument', {
			recordId: fileTo.recordId,
			recordKind: fileTo.recordKind,
			files: files.map(({ key, name, type }) => ({ key, name, type })),
			label: fileTo.label ?? 'other',
			sourceItemId: itemId,
		});
	} catch (error) {
		// Records is not installed or switched off: say so instead of "unknown action".
		if (isFamosError(error) && (error.code === 'feature_off' || error.code === 'not_found')) {
			throw new FamosError('bad_request', 'Filing papers on a record is not available');
		}
		throw error;
	}
}

const filedTo = (fileTo: FileTo) =>
	JSON.stringify({
		recordId: fileTo.recordId,
		recordKind: fileTo.recordKind,
		label: fileTo.label ?? 'other',
		recordName: fileTo.recordName ?? null,
	});

async function load(uow: UnitOfWork, id: string) {
	const row = await tables(uow.db)
		.selectFrom('inbox_items')
		.selectAll()
		.where('id', '=', id)
		.executeTakeFirst();
	if (!row) throw new FamosError('not_found', 'Inbox item not found');
	return row;
}

/**
 * Records a new item and queues it for reading. Called by the upload route after it stored the
 * files under `inbox/<id>/`; the id must be new and every file key must sit under it, so an item
 * can never claim another item's files.
 */
export const addItem = defineAction({
	id: 'inbox.addItem',
	title: 'Put something in the Family Inbox',
	input: z
		.object({
			id: InboxItemIdSchema,
			channel: ChannelSchema,
			title: z.string().trim().max(300).optional(),
			text: z.string().trim().max(20_000).optional(),
			url: z.url().max(2_000).optional(),
			files: z.array(StoredFileSchema).max(UPLOAD_LIMITS.maxFiles).default([]),
			/** File the files on a record yourself: the item is never sent to the AI. */
			fileTo: FileToSchema.optional(),
		})
		.refine((v) => v.text || v.url || v.title || v.files.length > 0, {
			message: 'The item is empty',
		})
		.refine((v) => !v.fileTo || v.files.length > 0, {
			message: 'There is nothing to file: add a photo or a document',
		})
		.refine((v) => v.files.every((f) => f.key.startsWith(`inbox/${v.id}/`)), {
			message: 'Files must belong to this item',
		}),
	output: InboxItemSchema,
	requires: inboxShare.id,
	approval: 'never',
	async run(uow, input) {
		const db = tables(uow.db);
		if (
			await db.selectFrom('inbox_items').select('id').where('id', '=', input.id).executeTakeFirst()
		) {
			throw new FamosError('conflict', 'This inbox item already exists');
		}
		const now = uow.clock.now();
		// The sizes come from the stored files, never from the caller.
		const files = await Promise.all(
			input.files.map(async (f) => ({ ...f, size: (await uow.files.stat(f.key))?.size ?? 0 })),
		);
		await assertQuota(
			uow.db,
			now,
			uow.actor,
			files.reduce((sum, f) => sum + f.size, 0),
		);
		const row = {
			id: input.id,
			channel: input.channel,
			title: input.title || null,
			text: input.text || null,
			url: input.url ?? null,
			files: JSON.stringify(files),
			status: input.fileTo ? ('filed' as const) : ('received' as const),
			filed_to: input.fileTo ? filedTo(input.fileTo) : null,
			normalized_text: null,
			transcript: null,
			summary: null,
			kind: null,
			error_code: null,
			read_attempt: null,
			proposals: 0,
			skipped: 0,
			skipped_unknown: 0,
			skips: '[]',
			model: null,
			extraction: 0,
			created_by: selfOf(uow.actor),
			created_at: now,
			updated_at: now,
		};
		await db.insertInto('inbox_items').values(row).execute();
		if (input.fileTo) {
			// Filed by hand: no job, so no model ever reads it.
			await fileOnRecord(uow, input.id, files, input.fileTo);
		} else {
			await uow.enqueue(
				PROCESS_JOB,
				{ itemId: input.id },
				{ dedupeKey: `${PROCESS_JOB}:${input.id}:0` },
			);
		}
		await uow.ai.reindex(ITEM_KIND, input.id);
		uow.emit(itemChanged, { itemId: input.id, memberId: row.created_by });
		return toItem(row);
	},
});

/**
 * Files an item that is already in the Inbox on a record ("File into…"). The AI may have read it
 * already; from now on the item counts as filed and is not read again.
 */
export const fileItem = defineAction({
	id: 'inbox.fileItem',
	title: 'File an inbox item on a record',
	input: z.object({ id: InboxItemIdSchema, fileTo: FileToSchema }),
	output: InboxItemSchema,
	requires: inboxShare.id,
	approval: 'never',
	async run(uow, { id, fileTo }) {
		const row = await load(uow, id);
		if (!mayHandle(uow.actor, row.created_by)) throw new FamosError('forbidden', 'Not your item');
		if (row.status === 'dismissed') throw new FamosError('not_found', 'Inbox item not found');
		const files = filesOf(row);
		if (files.length === 0)
			throw new FamosError('bad_request', 'There is nothing to file: the item has no files');
		await fileOnRecord(uow, id, files, fileTo);
		const patch = {
			status: 'filed' as const,
			filed_to: filedTo(fileTo),
			updated_at: uow.clock.now(),
		};
		await tables(uow.db).updateTable('inbox_items').set(patch).where('id', '=', id).execute();
		await uow.ai.reindex(ITEM_KIND, id);
		uow.emit(itemChanged, { itemId: id, memberId: row.created_by });
		return toItem({ ...row, ...patch });
	},
});

/**
 * Reads a failed or held item again (after fixing AI settings, turning AI on, or an outage), or
 * one that was read without a suggestion (after installing the area it was about, or adding the
 * thing it named). An item that is still being read is refused: it is already on its way. One
 * that gave suggestions is not read again, which would suggest the same things twice.
 */
export const retryItem = defineAction({
	id: 'inbox.retryItem',
	title: 'Read an inbox item again',
	input: z.object({ id: InboxItemIdSchema }),
	output: InboxItemSchema,
	requires: inboxShare.id,
	approval: 'never',
	async run(uow, { id }) {
		const row = await load(uow, id);
		if (!mayHandle(uow.actor, row.created_by)) throw new FamosError('forbidden', 'Not your item');
		// Still being read (or waiting for the job's own retry): reading again now would do nothing.
		if (row.status === 'received' || row.status === 'normalized')
			throw new FamosError('conflict', 'This item is still being read');
		const readAgain =
			row.status === 'failed' ||
			row.status === 'held' ||
			(row.status === 'extracted' && row.proposals === 0);
		if (!readAgain) return toItem(row);
		const extraction = row.extraction + 1;
		const patch = {
			// A voice note that could not be read goes through reading from the start.
			status: (row.normalized_text === null || row.error_code === 'voice_not_read'
				? 'received'
				: 'normalized') as 'received' | 'normalized',
			error_code: null,
			read_attempt: null,
			extraction,
			updated_at: uow.clock.now(),
		};
		await tables(uow.db).updateTable('inbox_items').set(patch).where('id', '=', id).execute();
		await uow.enqueue(
			PROCESS_JOB,
			{ itemId: id },
			{ dedupeKey: `${PROCESS_JOB}:${id}:${extraction}` },
		);
		await uow.ai.reindex(ITEM_KIND, id);
		uow.emit(itemChanged, { itemId: id, memberId: row.created_by });
		return toItem({ ...row, ...patch });
	},
});

/** Hides an item from the Inbox and rejects the suggestions still waiting from it. */
export const dismissItem = defineAction({
	id: 'inbox.dismissItem',
	title: 'Remove an item from the Family Inbox',
	input: z.object({ id: InboxItemIdSchema }),
	output: z.object({ ok: z.literal(true) }),
	requires: inboxShare.id,
	approval: 'never',
	async run(uow, { id }) {
		const row = await load(uow, id);
		if (!mayHandle(uow.actor, row.created_by)) throw new FamosError('forbidden', 'Not your item');
		await tables(uow.db)
			.updateTable('inbox_items')
			.set({ status: 'dismissed', updated_at: uow.clock.now() })
			.where('id', '=', id)
			.execute();
		await uow.rejectDraftsOf({ kind: 'inbox', id });
		await uow.ai.reindex(ITEM_KIND, id);
		uow.emit(itemChanged, { itemId: id, memberId: row.created_by });
		return { ok: true as const };
	},
});

/** A display name without path separators or control characters. */
const safeName = (name: string, i: number) =>
	[...name]
		.map((ch) => (ch.charCodeAt(0) < 32 || ch === '/' || ch === '\\' ? '_' : ch))
		.join('')
		.slice(0, 255) || `file-${i + 1}`;

/** Refuses an item that would take the member over their 24-hour quota. */
async function assertQuota(
	db: UnitOfWork['db'],
	now: number,
	actor: Actor,
	incoming: number,
): Promise<void> {
	if (!personPresent(actor)) return;
	const recent = await tables(db)
		.selectFrom('inbox_items')
		.select('files')
		.where('created_by', '=', actor.memberId)
		.where('created_at', '>', now - UPLOAD_QUOTA.windowMs)
		.execute();
	const used = recent.reduce(
		(sum, row) => sum + (JSON.parse(row.files) as StoredFile[]).reduce((s, f) => s + f.size, 0),
		0,
	);
	if (recent.length >= UPLOAD_QUOTA.items || used + incoming > UPLOAD_QUOTA.bytes)
		throw new FamosError('limit_reached', 'Daily upload limit reached; try again tomorrow');
}

export const createItem = defineRoute({
	method: 'post',
	path: '/items',
	operationId: 'inbox.createItem',
	summary: 'Share or upload something to the Family Inbox (multipart: text fields and files)',
	requires: inboxShare.id,
	body: NewItemFieldsSchema,
	upload: UPLOAD_LIMITS,
	response: InboxItemSchema,
	handle: (ctx, { body, files, actor }) => addUpload(ctx, actor, body, files),
});

/**
 * Where things shared from outside the app (Telegram, email) arrive: they become items exactly
 * as an upload from the app does, with the same quota, metadata stripping and AI reading.
 */
export const shareTarget: ShareTarget = {
	requires: inboxShare.id,
	limits: UPLOAD_LIMITS,
	async receive(ctx, actor, share) {
		const fields = NewItemFieldsSchema.safeParse({
			channel: share.channel,
			...(share.title !== undefined && { title: share.title }),
			...(share.text !== undefined && { text: share.text }),
			...(share.url !== undefined && { url: share.url }),
		});
		if (!fields.success) throw new FamosError('bad_request', 'This cannot be added');
		await addUpload(ctx, actor, fields.data, share.files);
	},
};

/** Stores the files of an upload and adds the item; the files go again if adding fails. */
async function addUpload(
	ctx: ExtensionContext,
	actor: Actor,
	body: z.infer<typeof NewItemFieldsSchema>,
	files: readonly UploadedFile[],
): Promise<z.infer<typeof InboxItemSchema>> {
	const { fileToRecordId, fileToRecordKind, fileToLabel, fileToRecordName, ...fields } = body;
	if (!fileToRecordId !== !fileToRecordKind)
		throw new FamosError('bad_request', 'Name both the record and its kind to file on');
	const fileTo: FileTo | undefined =
		fileToRecordId && fileToRecordKind
			? {
					recordId: fileToRecordId,
					recordKind: fileToRecordKind,
					...(fileToLabel && { label: fileToLabel }),
					...(fileToRecordName && { recordName: fileToRecordName }),
				}
			: undefined;
	// Refused before anything is stored; the action checks again against the stored files.
	await assertQuota(
		ctx.db,
		ctx.clock.now(),
		actor,
		files.reduce((sum, f) => sum + f.size, 0),
	);
	// Files cannot join a transaction: store them first, remove them if the action fails.
	const id = ctx.ids.next('inbox_item');
	const stored: z.infer<typeof StoredFileSchema>[] = [];
	try {
		for (const [i, file] of files.entries()) {
			const key = `inbox/${id}/${i}`;
			// Photos lose their location and other metadata before they are stored (and so before
			// any model sees them).
			const data = STRIPPED_TYPES.has(file.type)
				? stripImageMetadata(await file.bytes(), file.type)
				: file.stream();
			const stat = await ctx.files.put(key, data, file.type);
			stored.push({ key, name: safeName(file.name, i), type: file.type, size: stat.size });
		}
		const result = await ctx.actions.invoke<z.infer<typeof InboxItemSchema>>(
			'inbox.addItem',
			{ id, ...fields, files: stored, ...(fileTo && { fileTo }) },
			actor,
		);
		if (result.status !== 'applied') throw new FamosError('conflict', 'The item was not added');
		return result.output;
	} catch (error) {
		await Promise.all(stored.map((f) => ctx.files.delete(f.key)));
		if (error instanceof MalformedImageError)
			throw new FamosError('bad_request', 'A photo could not be read; it was not added');
		throw error;
	}
}

export const listItems = defineRoute({
	method: 'get',
	path: '/items',
	operationId: 'inbox.listItems',
	summary: 'Recent inbox items, newest first (dismissed items left out)',
	requires: inboxShare.id,
	query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }),
	response: z.array(InboxItemSchema),
	async handle(ctx, { query, actor }) {
		let rows = tables(ctx.db)
			.selectFrom('inbox_items')
			.selectAll()
			.where('status', '!=', 'dismissed');
		// Your own items, and those with a suggestion you must decide.
		const mine = selfOf(actor) ?? '';
		const others = await decidableItemIds(ctx, actor);
		rows = rows.where((eb) =>
			others.length > 0
				? eb.or([eb('created_by', '=', mine), eb('id', 'in', others)])
				: eb('created_by', '=', mine),
		);
		const recent = await rows.orderBy('created_at', 'desc').limit(query.limit).execute();
		// A suggestion waiting for a decision always has its item, however many newer items there
		// are: otherwise the page would hold fewer suggestions than the count of those waiting.
		const shown = new Set(recent.map((row) => row.id));
		const older = others.filter((id) => !shown.has(id));
		if (older.length === 0) return recent.map(toItem);
		const waiting = await tables(ctx.db)
			.selectFrom('inbox_items')
			.selectAll()
			.where('status', '!=', 'dismissed')
			.where('id', 'in', older)
			.execute();
		return [...recent, ...waiting].toSorted((a, b) => b.created_at - a.created_at).map(toItem);
	},
});

export const getItemFile = defineRoute({
	method: 'get',
	path: '/items/{itemId}/files/{index}',
	operationId: 'inbox.getItemFile',
	summary: 'A file of an inbox item (images, PDFs and audio open inline)',
	requires: inboxShare.id,
	params: z.object({ itemId: InboxItemIdSchema, index: z.coerce.number().int().min(0).max(20) }),
	response: FileResponseSchema,
	async handle(ctx, { params, actor }) {
		const row = await tables(ctx.db)
			.selectFrom('inbox_items')
			.selectAll()
			.where('id', '=', params.itemId)
			.executeTakeFirst();
		// Someone else's item looks like a missing one: nothing to learn from the answer.
		const visible =
			row &&
			(mayHandle(actor, row.created_by) || (await decidableItemIds(ctx, actor)).includes(row.id));
		const file = visible ? filesOf(row)[params.index] : undefined;
		const stored = file ? await ctx.files.get(file.key) : null;
		if (!file || !stored) throw new FamosError('not_found', 'File not found');
		return {
			stream: stored.stream,
			contentType: file.type,
			size: stored.stat.size,
			filename: file.name,
		};
	},
});
