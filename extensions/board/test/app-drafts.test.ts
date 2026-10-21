import type { Actor } from '@famos/sdk';
import type { TestKernel } from '@famos/testing';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardNote } from '../src/contract/index.ts';
import { applied, createKernel, type Person, person } from './support.ts';

let k: TestKernel;
let ayse: Person;

beforeEach(async () => {
	({ k } = await createKernel());
	ayse = await person(k, 'admin', 'Ayşe');
	await sql`insert into core_apps (id, name, role_id, mode, acts_for, created_at, updated_at)
		values ('app_home', 'Home Assistant', 'member', 'suggest', '[]', 0, 0)`.execute(k.ctx.db);
});
afterEach(() => k.close());

const suggesting: Actor = { kind: 'app', appId: 'app_home', roleId: 'member', mode: 'suggest' };

const waiting = async () =>
	(await k.route('core.listDrafts').call({ actor: ayse.actor, query: { limit: 50 } })) as {
		actionId: string;
		subject: string | null;
	}[];

describe('suggestions a connected app makes about a note', () => {
	it('name the note they change or take off, though they send only its id', async () => {
		const note = await applied<BoardNote>(
			k,
			'board.postNote',
			{ text: 'Door is open', paper: 'note-2' },
			ayse.actor,
		);
		await k.runner.invoke('board.editNote', { id: note.id, paper: 'note-1' }, suggesting);
		await k.runner.invoke('board.removeNote', { id: note.id }, suggesting);
		const drafts = await waiting();
		expect(drafts.map((d) => [d.actionId, d.subject]).toSorted()).toEqual([
			['board.editNote', 'Door is open'],
			['board.removeNote', 'Door is open'],
		]);
	});
});
