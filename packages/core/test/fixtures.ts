import {
	defineAction,
	defineCapability,
	defineEvent,
	defineJob,
	defineNotificationKind,
	FamosError,
	type NotifyRequest,
} from '@famos/sdk';
import { sql } from 'kysely';
import { z } from 'zod';
import { defineTestExtension } from './harness.ts';

/** A tiny extension exercising every contribution type, used by core tests. */
type NotesTables = { notes_items: { id: string; body: string; created_at: number } };

export const notesEdit = defineCapability({
	id: 'notes.edit',
	label: 'notes:cap_edit',
	level: 'edit',
});
export const notesPurge = defineCapability({
	id: 'notes.purge',
	label: 'notes:cap_purge',
	level: 'manage',
});

/** Default: every channel. */
export const notesAnnounced = defineNotificationKind({
	id: 'notes.announced',
	label: 'notes:notify_kind_announced',
});
/** Only on Telegram unless the member chooses otherwise. */
export const notesQuiet = defineNotificationKind({
	id: 'notes.quiet',
	label: 'notes:notify_kind_quiet',
	defaultChannels: ['telegram'],
});

export const noteAdded = defineEvent('notes.item.added', z.object({ id: z.string() }));
export const jobLog: string[] = [];

export const addNote = defineAction({
	id: 'notes.addNote',
	title: 'Add a note',
	input: z.object({
		body: z.string().min(1),
		fail: z.boolean().optional(),
		withJob: z.boolean().optional(),
	}),
	output: z.object({ id: z.string() }),
	approval: { unless: notesEdit.id },
	autoApprove: { label: 'notes:auto_approve', capabilities: [notesEdit.id, 'core.memory.use'] },
	undo: (note) => ({ actionId: 'notes.deleteNote', input: { id: note.id } }),
	async run(uow, input) {
		const id = uow.ids.next('note');
		await uow.db
			.withTables<NotesTables>()
			.insertInto('notes_items')
			.values({ id, body: input.body, created_at: uow.clock.now() })
			.execute();
		uow.emit(noteAdded, { id });
		if (input.withJob) await uow.enqueue('notes.process', { id });
		if (input.fail) throw new Error('domain failure after writes');
		return { id };
	},
});

/** Passes a notification request through, to test `uow.notify`. */
export const announce = defineAction({
	id: 'notes.announce',
	title: 'Announce',
	input: z.object({ request: z.custom<NotifyRequest>(), fail: z.boolean().optional() }),
	output: z.object({}),
	requires: notesEdit.id,
	async run(uow, input) {
		await uow.notify(input.request);
		if (input.fail) throw new Error('rolled back');
		return {};
	},
});

export const deleteNote = defineAction({
	id: 'notes.deleteNote',
	title: 'Delete a note',
	input: z.object({ id: z.string() }),
	output: z.object({ ok: z.literal(true) }),
	requires: notesEdit.id,
	async run(uow, { id }) {
		await uow.db.withTables<NotesTables>().deleteFrom('notes_items').where('id', '=', id).execute();
		return { ok: true as const };
	},
});

export const countNotes = defineAction({
	id: 'notes.countNotes',
	title: 'Count notes',
	input: z.object({}),
	output: z.object({ count: z.number() }),
	readOnly: true,
	async run(uow) {
		const row = await uow.db
			.withTables<NotesTables>()
			.selectFrom('notes_items')
			.select((eb) => eb.fn.countAll<number>().as('n'))
			.executeTakeFirstOrThrow();
		return { count: Number(row.n) };
	},
});

export const adminOnly = defineAction({
	id: 'notes.purge',
	title: 'Purge notes',
	input: z.object({}),
	output: z.object({ ok: z.boolean() }),
	requires: notesPurge.id,
	approval: 'always',
	async run(uow) {
		await uow.db.withTables<NotesTables>().deleteFrom('notes_items').execute();
		return { ok: true };
	},
});

export const childNeedsParent = defineAction({
	id: 'notes.share',
	title: 'Share a note with the family',
	input: z.object({ body: z.string() }),
	output: z.object({ ok: z.boolean() }),
	// Supervised members propose; members with the capability share directly.
	approval: { unless: notesEdit.id },
	async run() {
		return { ok: true };
	},
});

export const conflicting = defineAction({
	id: 'notes.conflict',
	title: 'Always conflicts',
	input: z.object({}),
	output: z.object({}),
	requires: notesEdit.id,
	async run() {
		throw new FamosError('conflict', 'nope');
	},
});

export const processNote = defineJob({
	name: 'notes.process',
	payload: z.object({ id: z.string(), fail: z.number().optional(), hang: z.boolean().optional() }),
	maxAttempts: 3,
	timeoutMs: 50,
	backoff: () => 1000,
	async handle(_ctx, payload, run) {
		jobLog.push(`${payload.id}#${run.attempt}`);
		if (payload.hang) await new Promise((resolve) => setTimeout(resolve, 200));
		if (payload.fail !== undefined && run.attempt <= payload.fail)
			throw new Error(`fail ${run.attempt}`);
	},
});

export const notesExtension = defineTestExtension({
	id: 'notes',
	migrations: {
		'0001_create_items': {
			async up(db) {
				await db.schema
					.createTable('notes_items')
					.addColumn('id', 'text', (c) => c.primaryKey())
					.addColumn('body', 'text', (c) => c.notNull())
					.addColumn('created_at', 'integer', (c) => c.notNull())
					.modifyEnd(sql`strict`)
					.execute();
			},
		},
	},
	actions: [addNote, announce, deleteNote, countNotes, adminOnly, childNeedsParent, conflicting],
	jobs: [processNote],
	events: [noteAdded],
	capabilities: [notesEdit, notesPurge],
	notifications: [notesAnnounced, notesQuiet],
});
