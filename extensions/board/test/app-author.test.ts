import type { Actor, MemberId } from '@famos/sdk';
import type { TestKernel } from '@famos/testing';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardNote } from '../src/contract/index.ts';
import { applied, createKernel, type Person, person, refused } from './support.ts';

let k: TestKernel;
let channel: Awaited<ReturnType<typeof createKernel>>['channel'];
let ayse: Person; // admin: manage
let bora: Person; // member: post

beforeEach(async () => {
	({ k, channel } = await createKernel());
	ayse = await person(k, 'admin', 'Ayşe');
	bora = await person(k, 'member', 'Bora');
});
afterEach(() => k.close());

const homeApp = (id = 'app_home'): Actor => ({
	kind: 'app',
	appId: id,
	roleId: 'member',
	mode: 'apply',
});
/** Bora, reached through the app: the member is who acts, and the app only carries the request. */
const boraViaApp = (): Actor => ({
	kind: 'member',
	memberId: bora.id as MemberId,
	roleId: 'member',
	via: { appId: 'app_home', appRoleId: 'member', mode: 'apply' },
});
const nameApp = async (id: string, name: string) => {
	await sql`insert into core_apps (id, name, role_id, mode, acts_for, created_at, updated_at)
		values (${id}, ${name}, 'member', 'apply', '[]', 0, 0)`.execute(k.ctx.db);
};
const post = (text: string, actor: Actor) =>
	applied<BoardNote>(k, 'board.postNote', { text, paper: 'note-2' }, actor);
const notes = (): Promise<BoardNote[]> => k.route('board.getNotes').call();

describe('notes an app puts up alone', () => {
	it('belong to the app: it is the author, shown by name, and may change and remove them', async () => {
		await nameApp('app_home', 'Home Assistant');
		const note = await post('Door open', homeApp());
		expect(note).toMatchObject({
			createdBy: null,
			createdByApp: { id: 'app_home', name: 'Home Assistant' },
		});
		expect(await notes()).toMatchObject([{ createdByApp: { name: 'Home Assistant' } }]);

		const edited = await applied<BoardNote>(
			k,
			'board.editNote',
			{ id: note.id, text: 'Door shut' },
			homeApp(),
		);
		expect(edited.text).toBe('Door shut');
		await applied(k, 'board.removeNote', { id: note.id }, homeApp());
		expect(await notes()).toEqual([]);
	});

	it('are not another app’s, a member’s or an app speaking for a member’s to change, but a manager’s', async () => {
		await nameApp('app_home', 'Home Assistant');
		const note = await post('Door open', homeApp());
		const edit = (actor: Actor) =>
			refused(k.runner.invoke('board.editNote', { id: note.id, text: 'x' }, actor));
		expect(await edit(homeApp('app_other'))).toBe('forbidden');
		expect(await edit(bora.actor)).toBe('forbidden');
		expect(await edit(boraViaApp())).toBe('forbidden');
		expect(await refused(k.runner.invoke('board.removeNote', { id: note.id }, bora.actor))).toBe(
			'forbidden',
		);
		await applied(k, 'board.editNote', { id: note.id, text: 'By a manager' }, ayse.actor);
	});

	it('leave a member’s note with the member when an app speaks for them', async () => {
		const note = await post('From Bora', boraViaApp());
		expect(note).toMatchObject({ createdBy: bora.id, createdByApp: null });
	});
});

describe('the notice of a note an app put up', () => {
	const titles = async () => {
		await k.worker.drain();
		return channel.sent
			.filter((s) => s.message.title.includes('board:posted_title'))
			.map((s) => s.message.title);
	};

	it('names the app when it posted alone', async () => {
		await nameApp('app_home', 'Home Assistant');
		await post('Door open', homeApp());
		expect(await titles()).toContain('en|board:posted_title_by|{"name":"Home Assistant"}');
	});

	it('names the member when an app speaks for them', async () => {
		await nameApp('app_home', 'Home Assistant');
		await post('From Bora', boraViaApp());
		const found = await titles();
		expect(found).toContain('en|board:posted_title_by|{"name":"Bora"}');
		expect(found.some((t) => t.includes('Home Assistant'))).toBe(false);
	});
});
