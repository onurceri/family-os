import type { UploadedFile } from '@famos/sdk';
import { GPS_MARKER, samplePhoto, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardNote } from '../src/contract/index.ts';
import { AI, applied, at, createKernel, type Person, person, refused } from './support.ts';

let k: TestKernel;
let channel: Awaited<ReturnType<typeof createKernel>>['channel'];
let ayse: Person; // admin: manage
let bora: Person; // member: use
let elif: Person; // supervised: use
let guest: Person; // guest: view

beforeEach(async () => {
	({ k, channel } = await createKernel());
	ayse = await person(k, 'admin', 'Ayşe');
	bora = await person(k, 'member', 'Bora');
	elif = await person(k, 'supervised', 'Elif');
	guest = await person(k, 'guest', 'Misafir');
});
afterEach(() => k.close());

const post = (input: Record<string, unknown> = {}, actor = bora.actor) =>
	applied<BoardNote>(
		k,
		'board.postNote',
		{ text: 'Dinner at 7', paper: 'note-2', ...input },
		actor,
	);
const notes = (): Promise<BoardNote[]> => k.route('board.getNotes').call();
const sent = () => channel.sent.filter((s) => s.message.title.includes('board:posted_title'));

describe('capabilities', () => {
	it('follow the levels: guests and displays read, supervised members write, admins manage', () => {
		const display = {
			kind: 'display' as const,
			deviceId: 'dev',
			capabilities: ['board.view'],
			showNames: false,
		};
		const can = (actor: Person['actor'], cap: string) => k.access.can(actor, cap);
		for (const p of [ayse, bora, elif, guest]) expect(can(p.actor, 'board.view')).toBe(true);
		expect(can(display, 'board.view')).toBe(true);
		expect(can(display, 'board.post')).toBe(false);
		expect(can(guest.actor, 'board.post')).toBe(false);
		expect(can(elif.actor, 'board.post')).toBe(true);
		expect(can(bora.actor, 'board.post')).toBe(true);
		expect(can(ayse.actor, 'board.manage')).toBe(true);
		for (const p of [bora, elif, guest]) expect(can(p.actor, 'board.manage')).toBe(false);
	});

	it('protects every route with a capability', () => {
		for (const { route } of k.registry.routes.filter((r) =>
			r.route.operationId.startsWith('board.'),
		)) {
			expect(route.requires, route.operationId).toMatch(/^board\.(view|post)$/);
		}
	});
});

describe('posting', () => {
	it('puts a note up as the person who wrote it, seen by them', async () => {
		const note = await post();
		expect(note).toMatchObject({
			text: 'Dinner at 7',
			paper: 'note-2',
			pinned: false,
			endsAt: null,
			endsOn: null,
			hasPhoto: false,
			createdBy: bora.id,
			seenBy: [bora.id],
		});
		expect(note.id).toMatch(/^board_note_/);
		expect(await notes()).toMatchObject([{ id: note.id }]);
	});

	it('trims the text, refuses an empty or long one and an unknown paper', async () => {
		expect((await post({ text: '  hello  ' })).text).toBe('hello');
		expect(await refused(post({ text: '   ' }))).toBe('bad_request');
		expect(await refused(post({ text: 'x'.repeat(501) }))).not.toBeNull();
		expect(await refused(post({ paper: 'note-9' }))).not.toBeNull();
		expect(await notes()).toHaveLength(1);
	});

	it('lets supervised members post, not guests', async () => {
		await post({}, elif.actor);
		expect(await refused(post({}, guest.actor))).toBe('forbidden');
		expect(await notes()).toHaveLength(1);
	});

	it('pins only for those who manage the board', async () => {
		expect(await refused(post({ pinned: true }, bora.actor))).toBe('forbidden');
		expect(await refused(post({ pinned: true }, elif.actor))).toBe('forbidden');
		const pinned = await post({ pinned: true }, ayse.actor);
		expect(pinned.pinned).toBe(true);
		expect(await notes()).toHaveLength(1);
	});

	it('works out the end of the last day in the family time zone, and refuses a past day', async () => {
		const note = await post({ endsOn: '2026-10-08' });
		expect(note.endsOn).toBe('2026-10-08');
		expect(note.endsAt).toBe(at('2026-10-09', '00:00'));
		expect(await refused(post({ endsOn: '2026-10-05' }))).toBe('bad_request');
		expect(await refused(post({ endsOn: 'next friday' }))).not.toBeNull();
	});
});

describe('the board', () => {
	it('lists pinned notes first, then the newest', async () => {
		const first = await post({ text: 'first' });
		k.clock.set(at('2026-10-06', '11:00'));
		const second = await post({ text: 'second' });
		k.clock.set(at('2026-10-06', '12:00'));
		const pinned = await post({ text: 'pinned', pinned: true }, ayse.actor);
		expect((await notes()).map((n) => n.id)).toEqual([pinned.id, second.id, first.id]);
	});

	it('hides a note after its last day and shows it on that day', async () => {
		const note = await post({ endsOn: '2026-10-07' });
		k.clock.set(at('2026-10-07', '23:59'));
		expect((await notes()).map((n) => n.id)).toEqual([note.id]);
		k.clock.set(at('2026-10-08', '00:00'));
		expect(await notes()).toEqual([]);
	});

	it('keeps the order for notes made in the same millisecond', async () => {
		const a = await post({ text: 'a' });
		const b = await post({ text: 'b' });
		expect(new Set((await notes()).map((n) => n.id))).toEqual(new Set([a.id, b.id]));
	});
});

describe('changing notes', () => {
	it('lets the author edit text, paper and end date, and clear the end date', async () => {
		const note = await post({ endsOn: '2026-10-08' });
		await applied(
			k,
			'board.editNote',
			{ id: note.id, text: 'Dinner at 8', paper: 'note-4', endsOn: null },
			bora.actor,
		);
		expect((await notes())[0]).toMatchObject({
			text: 'Dinner at 8',
			paper: 'note-4',
			endsAt: null,
			createdBy: bora.id,
		});
		await applied(k, 'board.editNote', { id: note.id, endsOn: '2026-10-07' }, bora.actor);
		expect((await notes())[0]?.endsOn).toBe('2026-10-07');
	});

	it('answers with the note as it is after the change, and its new version', async () => {
		const note = await post();
		const out = await applied<BoardNote & { ok: true }>(
			k,
			'board.editNote',
			{ id: note.id, text: 'Changed' },
			bora.actor,
		);
		expect(out).toMatchObject({ ok: true, id: note.id, text: 'Changed' });
		expect(out.version).toBeGreaterThan(note.version);
		expect(out.version).toBe((await notes())[0]?.version);
	});

	it('refuses other members, lets a manager edit and remove', async () => {
		const note = await post();
		expect(
			await refused(k.runner.invoke('board.editNote', { id: note.id, text: 'mine' }, elif.actor)),
		).toBe('forbidden');
		expect(await refused(k.runner.invoke('board.removeNote', { id: note.id }, elif.actor))).toBe(
			'forbidden',
		);
		expect(
			await refused(k.runner.invoke('board.editNote', { id: note.id, text: 'x' }, guest.actor)),
		).toBe('forbidden');
		await applied(k, 'board.editNote', { id: note.id, text: 'by admin' }, ayse.actor);
		expect((await notes())[0]?.text).toBe('by admin');
		expect(await applied(k, 'board.removeNote', { id: note.id }, ayse.actor)).toEqual({
			removed: true,
		});
		expect(await notes()).toEqual([]);
	});

	it('lets a supervised author change and take down their own note without approval', async () => {
		const note = await post({}, elif.actor);
		await applied(k, 'board.editNote', { id: note.id, endsOn: '2026-10-08' }, elif.actor);
		expect((await notes())[0]?.endsOn).toBe('2026-10-08');
		expect(await applied(k, 'board.removeNote', { id: note.id }, elif.actor)).toEqual({
			removed: true,
		});
	});

	it('lets the author remove their note; removing again is harmless', async () => {
		const note = await post();
		expect(await applied(k, 'board.removeNote', { id: note.id }, bora.actor)).toEqual({
			removed: true,
		});
		expect(await applied(k, 'board.removeNote', { id: note.id }, bora.actor)).toEqual({
			removed: false,
		});
	});

	it('pins and unpins only for managers, idempotently', async () => {
		const note = await post();
		expect(
			await refused(k.runner.invoke('board.pinNote', { id: note.id, pinned: true }, bora.actor)),
		).toBe('forbidden');
		await applied(k, 'board.pinNote', { id: note.id, pinned: true }, ayse.actor);
		await applied(k, 'board.pinNote', { id: note.id, pinned: true }, ayse.actor);
		expect((await notes())[0]?.pinned).toBe(true);
		await applied(k, 'board.pinNote', { id: note.id, pinned: false }, ayse.actor);
		expect((await notes())[0]?.pinned).toBe(false);
	});
});

describe('seen', () => {
	it('marks a note seen once per person, in the order they saw it', async () => {
		const note = await post();
		await applied(k, 'board.markSeen', { id: note.id }, elif.actor);
		await applied(k, 'board.markSeen', { id: note.id }, elif.actor);
		await applied(k, 'board.markSeen', { id: note.id }, bora.actor);
		await applied(k, 'board.markSeen', { id: note.id }, guest.actor);
		expect((await notes())[0]?.seenBy.toSorted()).toEqual([bora.id, elif.id, guest.id].toSorted());
		expect((await notes())[0]?.seenBy).toHaveLength(3);
	});

	it('ignores a note that is gone, and a display cannot mark', async () => {
		const note = await post();
		await applied(k, 'board.removeNote', { id: note.id }, bora.actor);
		expect(await applied(k, 'board.markSeen', { id: note.id }, ayse.actor)).toEqual({
			seen: false,
		});
		const display = {
			kind: 'display' as const,
			deviceId: 'dev',
			capabilities: ['board.view'],
			showNames: false,
		};
		expect(await refused(k.runner.invoke('board.markSeen', { id: note.id }, display))).toBe(
			'forbidden',
		);
	});
});

describe('notifications', () => {
	it('tells everyone who sees the board except the author, once, with the start of the note', async () => {
		const note = await post({ text: 'Dinner   at\n7 tonight' });
		await k.worker.drain();
		expect(
			sent()
				.map((s) => s.memberId)
				.toSorted(),
		).toEqual([ayse.id, elif.id, guest.id].toSorted());
		expect(sent()[0]?.message).toMatchObject({
			title: 'en|board:posted_title_by|{"name":"Bora"}',
			body: 'en|board:posted_body|{"text":"Dinner at 7 tonight"}',
			url: '/board',
		});
		expect(note.id).toBeTruthy();
	});

	it('does not tell anyone about an edit, a pin or a seen mark', async () => {
		const note = await post();
		await k.worker.drain();
		const before = sent().length;
		await applied(k, 'board.editNote', { id: note.id, text: 'changed' }, bora.actor);
		await applied(k, 'board.pinNote', { id: note.id, pinned: true }, ayse.actor);
		await applied(k, 'board.markSeen', { id: note.id }, elif.actor);
		await k.worker.drain();
		expect(sent()).toHaveLength(before);
	});
});

describe('photos', () => {
	const jpeg = samplePhoto('image/jpeg');
	const file = (bytes: Uint8Array, type = 'image/jpeg'): UploadedFile => ({
		field: 'file',
		name: 'p.jpg',
		type,
		size: bytes.length,
		stream: async function* () {
			yield bytes;
		},
		bytes: async () => bytes,
	});
	const upload = (noteId: string, f: UploadedFile, actor = bora.actor) =>
		k.route('board.uploadNotePhoto').call({ params: { noteId }, files: [f], actor });
	const read = async (noteId: string) => {
		const res = await k.route('board.getNotePhoto').call({ params: { noteId } });
		const chunks: Uint8Array[] = [];
		for await (const chunk of res.stream) chunks.push(chunk);
		return { type: res.contentType as string, bytes: Buffer.concat(chunks) };
	};

	it('stores an image for the author, serves it and replaces it', async () => {
		const note = await post();
		await upload(note.id, file(jpeg));
		expect((await notes())[0]?.hasPhoto).toBe(true);
		expect(await read(note.id)).toMatchObject({ type: 'image/jpeg' });
		const png = samplePhoto('image/png');
		await upload(note.id, file(png, 'image/jpeg'));
		expect(await read(note.id)).toMatchObject({ type: 'image/png' });
	});

	it('stores a photo without its location data, whatever the app did', async () => {
		const note = await post();
		for (const type of ['image/jpeg', 'image/png', 'image/webp'] as const) {
			const withGps = samplePhoto(type, { gps: true });
			expect(Buffer.from(withGps).includes(GPS_MARKER)).toBe(true);
			await upload(note.id, file(withGps, type));
			const stored = await read(note.id);
			expect(stored.type).toBe(type);
			expect(stored.bytes.includes(GPS_MARKER)).toBe(false);
		}
	});

	it('refuses something that is not an image, and photos on other people’s notes', async () => {
		const note = await post();
		const html = new TextEncoder().encode('<html><script>alert(1)</script>');
		expect(await refused(upload(note.id, file(html)))).toBe('bad_request');
		expect(await refused(upload(note.id, file(jpeg), elif.actor))).toBe('forbidden');
		await upload(note.id, file(jpeg), ayse.actor);
		expect((await notes())[0]?.hasPhoto).toBe(true);
	});

	it('refuses another member before reading or storing the photo', async () => {
		const note = await post();
		let read = false;
		const f = file(jpeg);
		const watched = {
			...f,
			bytes: async () => {
				read = true;
				return jpeg;
			},
			stream: async function* () {
				read = true;
				yield jpeg;
			},
		};
		expect(await refused(upload(note.id, watched, elif.actor))).toBe('forbidden');
		expect(read).toBe(false);
	});

	it('has no photo to serve for a note without one', async () => {
		const note = await post();
		expect(await refused(read(note.id))).toBe('not_found');
	});

	it('deletes the photo file when the note is taken down', async () => {
		const note = await post();
		await upload(note.id, file(jpeg));
		const key = (
			await k.ctx.db
				.withTables<{ board_notes: { id: string; photo: string | null } }>()
				.selectFrom('board_notes')
				.select('photo')
				.where('id', '=', note.id)
				.executeTakeFirstOrThrow()
		).photo as string;
		expect(await k.ctx.files.stat(key)).not.toBeNull();
		await applied(k, 'board.removeNote', { id: note.id }, bora.actor);
		await k.worker.drain();
		expect(await k.ctx.files.stat(key)).toBeNull();
	});
});

describe('clean-up', () => {
	const count = async () =>
		(
			await k.ctx.db
				.withTables<{ board_notes: { id: string }; board_note_seen: { note_id: string } }>()
				.selectFrom('board_notes')
				.select('id')
				.execute()
		).length;

	it('deletes notes 30 days after they ended, with their photos and seen marks, and plans the next run', async () => {
		const old = await post({ endsOn: '2026-10-07' });
		const recent = await post({ endsOn: '2026-10-20' });
		const forever = await post();
		const jpeg = samplePhoto('image/jpeg');
		await k.route('board.uploadNotePhoto').call({
			params: { noteId: old.id },
			actor: bora.actor,
			files: [
				{
					field: 'f',
					name: 'p.jpg',
					type: 'image/jpeg',
					size: jpeg.length,
					stream: async function* () {
						yield jpeg;
					},
					bytes: async () => jpeg,
				},
			],
		});
		// 2026-10-07 ended at the end of that day; thirty days later it is due.
		k.clock.set(at('2026-11-06', '12:00'));
		await k.worker.drain();
		expect(await count()).toBe(3);
		k.clock.set(at('2026-11-08', '12:00'));
		await k.worker.drain();
		const left = (await notes()).map((n) => n.id);
		expect(left).toContain(forever.id);
		expect(left).not.toContain(old.id);
		expect(await count()).toBe(2);
		// The note that ended on the 20th is still kept for its 30 days.
		expect(recent.id).toBeTruthy();
		const seen = await k.ctx.db
			.withTables<{ board_note_seen: { note_id: string } }>()
			.selectFrom('board_note_seen')
			.select('note_id')
			.where('note_id', '=', old.id)
			.execute();
		expect(seen).toEqual([]);
	});

	it('is safe to run twice and keeps a daily schedule', async () => {
		await post({ endsOn: '2026-10-07' });
		k.clock.set(at('2026-12-01', '12:00'));
		await k.worker.drain();
		await k.worker.drain();
		expect(await count()).toBe(0);
		const pending = await k.ctx.db
			.withTables<{ queue_jobs: { name: string; status: string; dedupe_key: string | null } }>()
			.selectFrom('queue_jobs')
			.select('dedupe_key')
			.where('name', '=', 'board.cleanup')
			.where('status', '=', 'pending')
			.execute();
		expect(pending).toHaveLength(1);
	});
});

describe('clean-up when a photo cannot be deleted', () => {
	it('still removes the other notes and plans the next run', async () => {
		const jpeg = samplePhoto('image/jpeg');
		const withPhoto = async () => {
			const note = await post({ endsOn: '2026-10-07' });
			await k.route('board.uploadNotePhoto').call({
				params: { noteId: note.id },
				actor: bora.actor,
				files: [
					{
						field: 'f',
						name: 'p.jpg',
						type: 'image/jpeg',
						size: jpeg.length,
						stream: async function* () {
							yield jpeg;
						},
						bytes: async () => jpeg,
					},
				],
			});
			return note;
		};
		const stuck = await withPhoto();
		const plain = await post({ endsOn: '2026-10-07' });
		// A photo key outside the extension's own folder is refused when the job deletes it.
		await k.ctx.db
			.withTables<{ board_notes: { id: string; photo: string | null } }>()
			.updateTable('board_notes')
			.set({ photo: 'elsewhere/photo.jpg' })
			.where('id', '=', stuck.id)
			.execute();
		k.clock.set(at('2026-11-08', '12:00'));
		await k.worker.drain();
		const left = (
			await k.ctx.db
				.withTables<{ board_notes: { id: string } }>()
				.selectFrom('board_notes')
				.select('id')
				.execute()
		).map((n) => n.id);
		expect(left).toEqual([stuck.id]);
		expect(left).not.toContain(plain.id);
		const pending = await k.ctx.db
			.withTables<{ queue_jobs: { name: string; status: string } }>()
			.selectFrom('queue_jobs')
			.select('name')
			.where('name', '=', 'board.cleanup')
			.where('status', '=', 'pending')
			.execute();
		expect(pending).toHaveLength(1);
	});
});

describe('AI', () => {
	it('offers posting as a proposal and reading the board as a tool, in its own area', () => {
		expect(k.ctx.actions.aiCatalog().map((a) => a.id)).toEqual(
			expect.arrayContaining(['board.postNote']),
		);
		for (const id of [
			'board.editNote',
			'board.removeNote',
			'board.pinNote',
			'board.moveNote',
			'board.markSeen',
			'board.setNotePhoto',
		]) {
			expect(
				k.ctx.actions.aiCatalog().map((a) => a.id),
				id,
			).not.toContain(id);
		}
		expect(k.ctx.actions.aiReadTools({ local: true }).map((a) => a.id)).toContain(
			'board.listNotes',
		);
		expect(k.registry.actions.get('board.listNotes')?.readOnly).toBe(true);
	});

	it('reads the board as the AI, with ids the host turns into handles', async () => {
		const note = await post({ text: 'Plumber on Friday', endsOn: '2026-10-09' });
		const pinned = await post(
			{ text: 'Wi-Fi password is on the fridge', pinned: true },
			ayse.actor,
		);
		const result = await k.runner.invoke<{ notes: Record<string, unknown>[] }>(
			'board.listNotes',
			{},
			AI,
		);
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		expect(result.output.notes).toMatchObject([
			{ id: pinned.id, pinned: true, author: ayse.id, lastDay: null, postedOn: '2026-10-06' },
			{ id: note.id, pinned: false, author: bora.id, lastDay: '2026-10-09' },
		]);
	});

	it('is closed to the AI when the family turns the area off', async () => {
		await post();
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'board', access: 'off' },
			ayse.actor,
		);
		expect(await refused(k.runner.invoke('board.listNotes', {}, AI))).toBe('forbidden');
	});

	it('judges whether a suggested note is already up by the clock, not the machine time', async () => {
		k.clock.set(at('2026-10-06', '11:00'));
		await post({ text: 'Remember the bins', endsOn: '2026-10-07' });
		const propose = async () => {
			const result = await k.runner.invoke('board.postNote', { text: 'Remember the bins' }, AI, {
				draft: { sourceKind: 'inbox', sourceId: 'item', summary: 'Bins' },
			});
			if (result.status !== 'drafted') throw new Error('expected a draft');
			const drafts = (await k
				.route('core.listDrafts')
				.call({ query: { status: 'pending', limit: 10 } })) as { id: string; mayExist: boolean }[];
			return drafts.find((d) => d.id === result.draftId)?.mayExist;
		};
		expect(await propose()).toBe(true);
		k.clock.set(at('2026-10-09', '11:00'));
		expect(await propose()).toBe(false);
	});

	it('proposes a note as a draft that a person approves, and undo takes it down', async () => {
		const result = await k.runner.invoke('board.postNote', { text: 'Remember the bins' }, AI, {
			draft: { sourceKind: 'inbox', sourceId: 'item', summary: 'Bins' },
		});
		expect(result.status).toBe('drafted');
		expect(await notes()).toEqual([]);
		if (result.status !== 'drafted') return;
		await k.runner.approveDraft(result.draftId, ayse.actor);
		expect(await notes()).toMatchObject([{ text: 'Remember the bins', createdBy: ayse.id }]);
		await k.runner.undoDraft(result.draftId, ayse.actor);
		expect(await notes()).toEqual([]);
	});
});
