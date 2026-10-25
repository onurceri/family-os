import { isFamosError } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardNote } from '../src/contract/index.ts';
import { tables } from '../src/server/store.ts';
import { applied, at, createKernel, type Person, person } from './support.ts';

let k: Awaited<ReturnType<typeof createKernel>>['k'];
let ayse: Person;
let bora: Person;

beforeEach(async () => {
	({ k } = await createKernel());
	ayse = await person(k, 'admin', 'Ayşe');
	bora = await person(k, 'member', 'Bora');
});
afterEach(() => k.close());

const post = async (input: Record<string, unknown> = {}) => {
	k.clock.advance(60_000);
	return applied<BoardNote>(
		k,
		'board.postNote',
		{ text: 'Dinner at 7', paper: 'note-2', ...input },
		bora.actor,
	);
};
const row = (id: string) =>
	tables(k.ctx.db)
		.selectFrom('board_notes')
		.select(['version', 'updated_at', 'pinned'])
		.where('id', '=', id)
		.executeTakeFirstOrThrow();

describe('the board in the change log', () => {
	it('counts a pin and a move, which leave updated_at alone', async () => {
		const a = await post();
		const b = await post();
		const posted = await row(a.id);
		// Posting counts the author's own sight of the note, which the note shows.
		expect(posted.version).toBeGreaterThanOrEqual(0);
		await applied(k, 'board.pinNote', { id: a.id, pinned: true }, ayse.actor);
		const pinned = await row(a.id);
		expect(pinned).toMatchObject({
			version: posted.version + 1,
			pinned: 1,
			updated_at: posted.updated_at,
		});
		const c = await post();
		const placed = (await row(c.id)).version;
		await applied(k, 'board.moveNote', { id: c.id, after: b.id }, bora.actor);
		expect((await row(c.id)).version).toBeGreaterThan(placed);
	});

	it('names every note a move renumbered', async () => {
		const a = await post();
		const b = await post();
		const c = await post();
		const seen = await k.changes.head();
		// The first arrangement numbers the whole group, so each note in it changed.
		await applied(k, 'board.moveNote', { id: a.id, before: c.id }, bora.actor);
		const page = await k.changes.since(seen, bora.actor);
		expect(new Set(page.changes.map((x) => x.id))).toEqual(new Set([a.id, b.id, c.id]));
	});

	it('raises the version of a note when someone sees it', async () => {
		const note = await post();
		const before = (await row(note.id)).version;
		await applied(k, 'board.markNotesSeen', { ids: [note.id] }, ayse.actor);
		expect((await row(note.id)).version).toBeGreaterThan(before);
	});

	it('leaves a tombstone for a removed note', async () => {
		const note = await post();
		await applied(k, 'board.removeNote', { id: note.id }, bora.actor);
		const page = await k.changes.since(0, bora.actor);
		expect(page.changes.map((c) => [c.id, c.op])).toEqual([[note.id, 'delete']]);
	});

	it('leaves a tombstone when the cleanup job removes an old note, with the delete', async () => {
		const old = await post({ endsOn: '2026-10-07' });
		const seen = await k.changes.head();
		k.clock.set(at('2026-11-08', '12:00'));
		await k.worker.drain();
		const gone = await tables(k.ctx.db).selectFrom('board_notes').select('id').execute();
		expect(gone).toEqual([]);
		const page = await k.changes.since(seen, bora.actor);
		expect(page.changes.map((c) => [c.id, c.op])).toEqual([[old.id, 'delete']]);
	});

	it('refuses a conditional pin on a note that moved on', async () => {
		const note = await post();
		await applied(k, 'board.pinNote', { id: note.id, pinned: true }, ayse.actor);
		const error = await k.runner
			.invoke('board.pinNote', { id: note.id, pinned: false }, ayse.actor, { ifMatch: 0 })
			.catch((e: unknown) => e);
		expect(isFamosError(error) && error.code).toBe('precondition_failed');
		expect((await row(note.id)).pinned).toBe(1);
	});
});
