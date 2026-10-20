import {
	type DigestItem,
	defineAction,
	defineDigest,
	defineJob,
	defineRoute,
	digestNotes,
	digestOf,
	type ExtensionContext,
	FamosError,
	FileResponseSchema,
	selfOf,
	type UnitOfWork,
} from '@famos/sdk';
import { compareDates, dayBounds, todayIn, zoned } from '@famos/time';
import { sql } from 'kysely';
import { z } from 'zod';
import {
	type BoardNote,
	BoardNoteSchema,
	EditNoteSchema,
	KEEP_AFTER_END_DAYS,
	MoveNoteSchema,
	NoteIdSchema,
	PostNoteSchema,
} from '../contract/index.ts';
import { boardChanged, boardManage, boardPost, boardView, postedKind } from './capabilities.ts';
import { api } from './public.ts';
import { type NoteRow, tables, toNote } from './store.ts';

const DAY_MS = 86_400_000;

export const memberId = selfOf;

type Db = UnitOfWork['db'];

async function loadNote(db: Db, id: string): Promise<NoteRow> {
	const row = await tables(db)
		.selectFrom('board_notes')
		.selectAll()
		.where('id', '=', id)
		.executeTakeFirst();
	if (!row) throw new FamosError('not_found', 'Note not found');
	return row;
}

/** The author, or a manager (`board.manage`); the author must still be allowed to post. */
function assertMayChange(uow: UnitOfWork, row: NoteRow): void {
	if (uow.can(boardManage.id)) return;
	const me = memberId(uow.actor);
	if (me !== null && row.created_by === me && uow.can(boardPost.id)) return;
	throw new FamosError('forbidden', 'Only the author or a manager can change this note');
}

/** The instant a note leaves the board when its last day is `date` (family time). */
async function endOfDay(
	family: Pick<UnitOfWork['family'], 'settings'>,
	date: string,
	now: number,
): Promise<number> {
	const { timeZone } = await family.settings();
	if (compareDates(date, todayIn(timeZone, now)) < 0)
		throw new FamosError('bad_request', 'The end date has passed');
	return dayBounds(date, timeZone).end;
}

const endsOnOf = (endsAt: number | null, timeZone: string): string | null =>
	endsAt === null
		? null
		: zoned(endsAt - 1, timeZone)
				.toPlainDate()
				.toString();

/**
 * The notes on the board now (not ended), in board order: pinned first; within each group the
 * notes someone arranged by their position, then the ones never arranged, newest first.
 */
function onBoard(db: Db, now: number) {
	return tables(db)
		.selectFrom('board_notes')
		.selectAll()
		.where((eb) => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', now)]))
		.orderBy('pinned', 'desc')
		.orderBy(sql`position is null`)
		.orderBy('position')
		.orderBy('created_at', 'desc')
		.orderBy('id', 'desc');
}

/** The notes of one group (pinned or not) on the board now, in board order. */
const groupOf = (db: Db, pinned: number, now: number) =>
	onBoard(db, now).where('pinned', '=', pinned).execute();

/**
 * Where a note joins a group at the top: before the first arranged note, or null while nobody has
 * arranged the group (then the newest note is first anyway).
 */
async function topOf(db: Db, pinned: number, now: number): Promise<number | null> {
	const first = await tables(db)
		.selectFrom('board_notes')
		.select((eb) => eb.fn.min('position').as('min'))
		.where('pinned', '=', pinned)
		.where((eb) => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', now)]))
		.executeTakeFirst();
	const min = first?.min ?? null;
	return min === null ? null : Number(min) - 1;
}

/** Below this gap between two neighbours the group is numbered afresh (1, 2, 3 …). */
const MIN_GAP = 1e-6;

/** The notes with these ids, whether or not they are on the board now. */
async function notesById(
	ctx: Pick<ExtensionContext, 'db' | 'family'>,
	ids: readonly string[],
): Promise<BoardNote[]> {
	const rows = await tables(ctx.db)
		.selectFrom('board_notes')
		.selectAll()
		.where('id', 'in', ids)
		.execute();
	const seen = rows.length
		? await tables(ctx.db)
				.selectFrom('board_note_seen')
				.select(['note_id', 'member_id'])
				.where('note_id', 'in', ids)
				.orderBy('seen_at')
				.execute()
		: [];
	const { timeZone } = await ctx.family.settings();
	return rows.map((row) =>
		toNote(
			row,
			seen.filter((s) => s.note_id === row.id).map((s) => s.member_id),
			endsOnOf(row.ends_at, timeZone),
		),
	);
}

/** Notes that are on the board now, in board order. */
async function visibleNotes(ctx: Pick<ExtensionContext, 'db' | 'family' | 'clock'>) {
	const now = ctx.clock.now();
	const rows = await onBoard(ctx.db, now).limit(200).execute();
	const seen = rows.length
		? await tables(ctx.db)
				.selectFrom('board_note_seen')
				.select(['note_id', 'member_id'])
				.where(
					'note_id',
					'in',
					rows.map((r) => r.id),
				)
				.orderBy('seen_at')
				.execute()
		: [];
	const { timeZone } = await ctx.family.settings();
	return rows.map((row) =>
		toNote(
			row,
			seen.filter((s) => s.note_id === row.id).map((s) => s.member_id),
			endsOnOf(row.ends_at, timeZone),
		),
	);
}

/** A short line of a note for a notification. */
export function excerpt(text: string, max = 120): string {
	const line = text.replace(/\s+/g, ' ').trim();
	return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

export const postNote = defineAction({
	id: 'board.postNote',
	expose: api.createNote,
	title: 'Put a note on the family board',
	draftTitle: 'board:draft_title_post_note',
	input: PostNoteSchema,
	output: BoardNoteSchema,
	requires: boardPost.id,
	approval: 'ai',
	undo: (note) => ({ actionId: 'board.removeNote', input: { id: note.id } }),
	// A note whose last day has passed would never be seen.
	draftDate: (input) => input.endsOn,
	ai: {
		description:
			'Put a short note on the family board, where everyone sees it (a reminder, a message to the family, something to remember). Use it only when a person asked for something to be shared with the whole family.',
		guidance:
			'Write the note as the person would, in their language, at most 500 characters. Never set pinned. Set endsOn only when the note stops mattering on a known day ("until Friday").',
	},
	async alreadyThere(ctx, input) {
		const row = await tables(ctx.db)
			.selectFrom('board_notes')
			.select('id')
			.where('text', '=', input.text)
			.where((eb) => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', ctx.now)]))
			.executeTakeFirst();
		return row !== undefined;
	},
	async run(uow, input) {
		if (input.pinned && !uow.can(boardManage.id))
			throw new FamosError('forbidden', 'Only managers can pin a note');
		const now = uow.clock.now();
		const endsAt = input.endsOn ? await endOfDay(uow.family, input.endsOn, now) : null;
		const author = memberId(uow.actor);
		const pinned = input.pinned ? 1 : 0;
		const row: NoteRow = {
			id: uow.ids.next('board_note'),
			text: input.text,
			photo: null,
			photo_type: null,
			paper: input.paper,
			pinned,
			ends_at: endsAt,
			created_by: author,
			created_at: now,
			updated_at: now,
			// A new note comes first in its group, also on a board the family has arranged.
			position: await topOf(uow.db, pinned, now),
			version: 0,
		};
		await tables(uow.db).insertInto('board_notes').values(row).execute();
		// The author has seen their own note.
		if (author)
			await tables(uow.db)
				.insertInto('board_note_seen')
				.values({ note_id: row.id, member_id: author, seen_at: now })
				.execute();
		// The notice names the person who put the note up, when there is one.
		const name = author
			? (await uow.family.members()).find((m) => m.id === author)?.displayName
			: undefined;
		await uow.notify({
			kind: postedKind.id,
			to: { capability: boardView.id, ...(author && { except: author }) },
			title: name
				? { key: 'board:posted_title_by', params: { name } }
				: { key: 'board:posted_title' },
			body: { key: 'board:posted_body', params: { text: excerpt(input.text) } },
			url: '/board',
			source: { kind: 'board.note', id: row.id },
			dedupeKey: `board.posted:${row.id}`,
		});
		uow.emit(boardChanged, { noteId: row.id });
		const { timeZone } = await uow.family.settings();
		return toNote(row, author ? [author] : [], endsOnOf(endsAt, timeZone));
	},
});

export const editNote = defineAction({
	id: 'board.editNote',
	target: ({ id }) => ({ table: 'board_notes', id, versionColumn: 'version' }),
	title: 'Change a note on the family board',
	expose: api.editNote,
	input: EditNoteSchema,
	// `ok` is what callers have always read; the note as it is now follows.
	output: BoardNoteSchema.extend({ ok: z.literal(true) }),
	requires: boardView.id,
	approval: 'never',
	async run(uow, { id, text, paper, endsOn }) {
		const row = await loadNote(uow.db, id);
		assertMayChange(uow, row);
		const now = uow.clock.now();
		const patch: Partial<NoteRow> = { updated_at: now };
		if (text !== undefined) patch.text = text;
		if (paper !== undefined) patch.paper = paper;
		if (endsOn !== undefined)
			patch.ends_at = endsOn === null ? null : await endOfDay(uow.family, endsOn, now);
		await tables(uow.db).updateTable('board_notes').set(patch).where('id', '=', id).execute();
		uow.emit(boardChanged, { noteId: id });
		// Read again: the write moved the note's version on.
		const [changed] = await notesById(uow, [id]);
		return { ok: true as const, ...(changed as BoardNote) };
	},
});

export const removeNote = defineAction({
	id: 'board.removeNote',
	expose: api.removeNote,
	target: ({ id }) => ({ table: 'board_notes', id, versionColumn: 'version' }),
	title: 'Take a note off the family board',
	input: z.object({ id: NoteIdSchema }),
	output: z.object({ removed: z.boolean() }),
	requires: boardView.id,
	approval: 'never',
	async run(uow, { id }) {
		const row = await tables(uow.db)
			.selectFrom('board_notes')
			.selectAll()
			.where('id', '=', id)
			.executeTakeFirst();
		// Already gone (undoing twice, a second tap): nothing to do.
		if (!row) return { removed: false };
		assertMayChange(uow, row);
		await tables(uow.db).deleteFrom('board_notes').where('id', '=', id).execute();
		// The file goes with a job, so it is removed only if the row really is gone.
		if (row.photo) await uow.enqueue('board.deleteFile', { key: row.photo });
		uow.emit(boardChanged, { noteId: id, op: 'delete' });
		return { removed: true };
	},
});

export const pinNote = defineAction({
	id: 'board.pinNote',
	target: ({ id }) => ({ table: 'board_notes', id, versionColumn: 'version' }),
	title: 'Pin or unpin a note on the family board',
	input: z.object({ id: NoteIdSchema, pinned: z.boolean() }),
	output: z.object({ ok: z.literal(true) }),
	requires: boardManage.id,
	approval: 'never',
	async run(uow, { id, pinned }) {
		const row = await loadNote(uow.db, id);
		if ((row.pinned === 1) !== pinned) {
			const group = pinned ? 1 : 0;
			await tables(uow.db)
				.updateTable('board_notes')
				// It joins its new group at the top.
				.set({ pinned: group, position: await topOf(uow.db, group, uow.clock.now()) })
				.where('id', '=', id)
				.execute();
			uow.emit(boardChanged, { noteId: id });
		}
		return { ok: true as const };
	},
});

export const moveNote = defineAction({
	id: 'board.moveNote',
	target: ({ id }) => ({ table: 'board_notes', id, versionColumn: 'version' }),
	title: 'Move a note on the family board',
	input: MoveNoteSchema,
	output: z.object({ moved: z.boolean() }),
	requires: boardView.id,
	approval: 'never',
	async run(uow, { id, before, after }) {
		const row = await loadNote(uow.db, id);
		assertMayChange(uow, row);
		const targetId = (before ?? after) as string;
		if (targetId === id) throw new FamosError('bad_request', 'A note cannot move beside itself');
		const now = uow.clock.now();
		const group = await groupOf(uow.db, row.pinned, now);
		const current = group.findIndex((n) => n.id === id);
		const others = group.filter((n) => n.id !== id);
		const target = others.findIndex((n) => n.id === targetId);
		if (current < 0) throw new FamosError('bad_request', 'This note is no longer on the board');
		if (target < 0) {
			// Pinned notes stay first: a note moves only among notes of its own group.
			const other = await onBoard(uow.db, now).where('id', '=', targetId).executeTakeFirst();
			throw new FamosError(
				'bad_request',
				other
					? row.pinned
						? 'A pinned note can only go before or after another pinned note'
						: 'A note that is not pinned can only go before or after another note that is not pinned'
					: 'The note to put it beside is not on the board any more',
			);
		}
		const index = before !== undefined ? target : target + 1;
		// Already there (a second tap, a drop where it started): nothing changes.
		if (index === current) return { moved: false };

		const arranged = group.every((n) => n.position !== null);
		// In an arranged group every position is a number.
		const prev = others[index - 1]?.position ?? undefined;
		const next = others[index]?.position ?? undefined;
		const moved: string[] = [];
		const set = (noteId: string, position: number) => {
			moved.push(noteId);
			return tables(uow.db)
				.updateTable('board_notes')
				.set({ position })
				.where('id', '=', noteId)
				.execute();
		};
		const roomy = prev === undefined || next === undefined || next - prev > MIN_GAP;
		if (arranged && roomy) {
			const position =
				prev === undefined ? (next ?? 0) - 1 : next === undefined ? prev + 1 : (prev + next) / 2;
			await set(id, position);
		} else {
			// The first arrangement (or a gap worn too thin): number the whole group in its new order.
			const order = [...others.slice(0, index), row, ...others.slice(index)];
			for (const [i, note] of order.entries()) await set(note.id, i + 1);
		}
		// Renumbering a group moves every note in it, and each one is told.
		for (const noteId of moved) uow.emit(boardChanged, { noteId });
		return { moved: true };
	},
});

export const markSeen = defineAction({
	id: 'board.markSeen',
	title: 'Mark a note as seen',
	input: z.object({ id: NoteIdSchema }),
	output: z.object({ seen: z.boolean() }),
	requires: boardView.id,
	approval: 'never',
	async run(uow, { id }) {
		const me = memberId(uow.actor);
		const exists = await tables(uow.db)
			.selectFrom('board_notes')
			.select('id')
			.where('id', '=', id)
			.executeTakeFirst();
		// A note taken down meanwhile is no error.
		if (!me || !exists) return { seen: false };
		const inserted = await tables(uow.db)
			.insertInto('board_note_seen')
			.values({ note_id: id, member_id: me, seen_at: uow.clock.now() })
			.onConflict((oc) => oc.doNothing())
			.executeTakeFirst();
		if (Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0) uow.emit(boardChanged, { noteId: id });
		return { seen: true };
	},
});

/** Stores the photo the upload route already put in the file store. */
export const setNotePhoto = defineAction({
	id: 'board.setNotePhoto',
	title: 'Set the photo of a note',
	input: z.object({
		id: NoteIdSchema,
		// Only keys the upload route makes: the action is also reachable at /actions.
		key: z.string().regex(/^board\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/),
		type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
	}),
	output: z.object({ previousKey: z.string().nullable() }),
	requires: boardPost.id,
	approval: 'never',
	async run(uow, { id, key, type }) {
		if (!key.startsWith(`board/${id}/`))
			throw new FamosError('bad_request', 'The photo belongs to another note');
		const row = await loadNote(uow.db, id);
		assertMayChange(uow, row);
		await tables(uow.db)
			.updateTable('board_notes')
			.set({ photo: key, photo_type: type, updated_at: uow.clock.now() })
			.where('id', '=', id)
			.execute();
		uow.emit(boardChanged, { noteId: id });
		return { previousKey: row.photo };
	},
});

/** Removes the photo file of a note that is gone (or whose photo was replaced). */
export const deleteFileJob = defineJob({
	name: 'board.deleteFile',
	payload: z.object({ key: z.string().min(1) }),
	async handle(ctx, { key }) {
		await ctx.files.delete(key);
	},
});

export const getNotes = defineRoute({
	method: 'get',
	path: '/notes',
	operationId: 'board.getNotes',
	expose: api.listNotes,
	summary:
		'The notes on the board now: pinned first, then in the order the family arranged them (newest first for notes never moved)',
	requires: boardView.id,
	response: z.array(BoardNoteSchema),
	async handle(ctx) {
		return visibleNotes(ctx);
	},
});

export const getNotePhoto = defineRoute({
	method: 'get',
	path: '/notes/{noteId}/photo',
	operationId: 'board.getNotePhoto',
	summary: 'The photo of a note',
	requires: boardView.id,
	params: z.object({ noteId: NoteIdSchema }),
	response: FileResponseSchema,
	async handle(ctx, { params }) {
		const row = await loadNote(ctx.db, params.noteId);
		const stored = row.photo ? await ctx.files.get(row.photo) : null;
		if (!row.photo || !row.photo_type || !stored)
			throw new FamosError('not_found', 'Photo not found');
		return {
			stream: stored.stream,
			contentType: row.photo_type,
			size: stored.stat.size,
			filename: 'photo',
		};
	},
});

const PHOTO_MAX_BYTES = 6 * 1024 * 1024;

/** The image type from the first bytes; the client's claim is not trusted. */
function sniffImage(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
	if (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a
	)
		return 'image/png';
	const text = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
	if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'image/webp';
	return null;
}

export const uploadNotePhoto = defineRoute({
	method: 'post',
	path: '/notes/{noteId}/photo',
	operationId: 'board.uploadNotePhoto',
	summary:
		'Set the photo of a note (multipart: one JPEG, PNG or WebP image; the app shrinks and re-encodes it first)',
	requires: boardPost.id,
	params: z.object({ noteId: NoteIdSchema }),
	upload: {
		maxBytes: PHOTO_MAX_BYTES + 64 * 1024,
		maxFiles: 1,
		accept: ['image/jpeg', 'image/png', 'image/webp'],
	},
	response: z.object({ ok: z.literal(true) }),
	async handle(ctx, { params, files, actor }) {
		const file = files[0];
		if (!file) throw new FamosError('bad_request', 'Send one image');
		if (file.size > PHOTO_MAX_BYTES) throw new FamosError('bad_request', 'The photo is too large');
		await loadNote(ctx.db, params.noteId);
		const bytes = await file.bytes();
		if (bytes.byteLength > PHOTO_MAX_BYTES)
			throw new FamosError('bad_request', 'The photo is too large');
		const type = sniffImage(bytes);
		if (!type) throw new FamosError('bad_request', 'The photo must be a JPEG, PNG or WebP image');
		// Files cannot join a transaction: store first, remove again if the action fails.
		const key = `board/${params.noteId}/${ctx.ids.next('photo')}`;
		await ctx.files.put(key, bytes, type);
		let previousKey: string | null;
		try {
			const result = await ctx.actions.invoke<{ previousKey: string | null }>(
				'board.setNotePhoto',
				{ id: params.noteId, key, type },
				actor,
			);
			if (result.status !== 'applied') throw new FamosError('conflict', 'The photo was not saved');
			previousKey = result.output.previousKey;
		} catch (error) {
			await ctx.files.delete(key);
			throw error;
		}
		// The new photo is saved; a leftover old file is only wasted space.
		if (previousKey) await ctx.files.delete(previousKey).catch(() => undefined);
		return { ok: true as const };
	},
});

const AI_MAX = 30;

export const aiListNotes = defineAction({
	id: 'board.listNotes',
	title: 'The family board, for the AI',
	input: z.object({}),
	output: z.object({
		notes: z.array(
			z.object({
				id: z.string(),
				text: z.string(),
				pinned: z.boolean(),
				postedOn: z.string(),
				lastDay: z.string().nullable(),
				author: z.string().nullable(),
			}),
		),
	}),
	readOnly: true,
	requires: boardView.id,
	ai: {
		description:
			'Lists the notes on the family board now (pinned first, then in the order the family arranged them, newest first otherwise): what the family has told each other, with who wrote it and the last day it stays up.',
	},
	async run(uow) {
		const now = uow.clock.now();
		const { timeZone } = await uow.family.settings();
		const rows = await onBoard(uow.db, now).limit(AI_MAX).execute();
		return {
			notes: rows.map((r) => ({
				id: r.id,
				text: r.text,
				pinned: r.pinned === 1,
				postedOn: zoned(r.created_at, timeZone).toPlainDate().toString(),
				lastDay: endsOnOf(r.ends_at, timeZone),
				author: r.created_by,
			})),
		};
	},
});

/** How much of a note's text titles its digest item; the rest is its notes. */
const DIGEST_TITLE_MAX = 200;

/**
 * The notes that are on the board on some day of a span, in board order (pinned first). A note
 * is for everyone, so the people asked about never leave one out. Each stands on the first day
 * of the span it is up, and says the last day it stays up.
 */
export const boardDigest = defineDigest({
	id: 'board.digest',
	topic: 'board',
	title: 'Notes on the family board in some days, for an answer',
	description:
		'The notes on the family board on the days asked about, pinned first: what the family told each other, who wrote it, when it went up and the last day it stays.',
	requires: boardView.id,
	async run(uow, input) {
		const { timeZone } = await uow.family.settings();
		const start = dayBounds(input.from, timeZone).start;
		const end = dayBounds(input.to, timeZone).end;
		const rows = await tables(uow.db)
			.selectFrom('board_notes')
			.selectAll()
			.where('created_at', '<', end)
			.where((eb) => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', start)]))
			.orderBy('pinned', 'desc')
			.orderBy(sql`position is null`)
			.orderBy('position')
			.orderBy('created_at', 'desc')
			.orderBy('id', 'desc')
			.execute();
		const items = rows.map((row): DigestItem => {
			const posted = zoned(row.created_at, timeZone).toPlainDate().toString();
			const lastDay = endsOnOf(row.ends_at, timeZone);
			const text = row.text.trim();
			const long = text.length > DIGEST_TITLE_MAX;
			const notes = long ? digestNotes(text) : undefined;
			return {
				handle: row.id,
				kind: 'note',
				title: long ? `${text.slice(0, DIGEST_TITLE_MAX - 1).trimEnd()}…` : text,
				date: compareDates(posted, input.from) < 0 ? input.from : posted,
				...(lastDay && { end: { date: lastDay } }),
				people: [],
				...(notes && { notes }),
				...(row.pinned === 1 && { status: 'pinned' as const }),
				extra: { posted, ...(row.created_by && { author: row.created_by }) },
				href: '/board',
			};
		});
		return digestOf(items, input);
	},
});

const NEXT_RUN_HOUR_UTC = 3;
/** The next 03:00 UTC after `now`. */
export const nextCleanupAt = (now: number): number => {
	const day = Math.floor(now / DAY_MS) * DAY_MS;
	const today = day + NEXT_RUN_HOUR_UTC * 3_600_000;
	return today > now ? today : today + DAY_MS;
};
const cleanupKey = (at: number) => `board.cleanup:${new Date(at).toISOString().slice(0, 10)}`;

/** Plans the next daily clean-up (once: the key names the day). */
export async function scheduleCleanup(ctx: Pick<ExtensionContext, 'enqueue' | 'clock'>) {
	const at = nextCleanupAt(ctx.clock.now());
	await ctx.enqueue('board.cleanup', {}, { runAt: at, dedupeKey: cleanupKey(at) });
}

/**
 * Notes (and their photos) go 30 days after they ended. Safe to run twice: it selects what is
 * due, removes the file and then the row, so a failure in between leaves the row for the next run.
 */
export const cleanupJob = defineJob({
	name: 'board.cleanup',
	payload: z.object({}),
	lane: 'default',
	async handle(ctx) {
		const before = ctx.clock.now() - KEEP_AFTER_END_DAYS * DAY_MS;
		const due = await tables(ctx.db)
			.selectFrom('board_notes')
			.select(['id', 'photo'])
			.where('ends_at', 'is not', null)
			.where('ends_at', '<', before)
			.execute();
		for (const note of due) {
			if (note.photo) await ctx.files.delete(note.photo);
			// The removal and its entry in the change log are one transaction.
			await ctx.unit(async (uow) => {
				await tables(uow.db).deleteFrom('board_notes').where('id', '=', note.id).execute();
				uow.emit(boardChanged, { noteId: note.id, op: 'delete' });
			});
		}
		await scheduleCleanup(ctx);
	},
});
