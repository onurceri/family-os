import {
	type Actor,
	defineAction,
	defineCapability,
	LlmError,
	type MemberId,
	systemActor,
} from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestKernel, defineTestExtension, type TestKernel } from '../src/index.ts';

/**
 * Family search against two throwaway extensions: `notes` (open) and `stash`
 * (sensitive, so its AI area starts Off). Their "tables" are in-memory maps; the fake embedding
 * model is a hashed bag of words, so ranking is predictable.
 */
type Note = { title: string; text: string; owner?: string | null };
const store = new Map<string, Note>();

const notesView = defineCapability({
	id: 'notes.view',
	label: 'notes:cap_view',
	level: 'view',
	defaults: { admin: true, member: true, supervised: true, guest: false },
});
const notesAll = defineCapability({ id: 'notes.viewAll', label: 'notes:cap_all', level: 'edit' });
const stashView = defineCapability({ id: 'stash.view', label: 'stash:cap_view', level: 'view' });

const NoteInput = z.object({
	id: z.string(),
	title: z.string(),
	text: z.string(),
	owner: z.string().nullable().optional(),
});
const putNote = defineAction({
	id: 'notes.put',
	title: 'Save a note',
	input: NoteInput,
	output: z.object({ ok: z.literal(true) }),
	requires: notesView.id,
	approval: 'never',
	async run(uow, { id, ...note }) {
		store.set(id, note);
		await uow.ai.reindex('notes.note', id);
		return { ok: true as const };
	},
});
const dropNote = defineAction({
	id: 'notes.drop',
	title: 'Delete a note',
	input: z.object({ id: z.string() }),
	output: z.object({ ok: z.literal(true) }),
	requires: notesView.id,
	approval: 'never',
	async run(uow, { id }) {
		store.delete(id);
		await uow.ai.remove('notes.note', id);
		return { ok: true as const };
	},
});
const putSecret = defineAction({
	id: 'stash.put',
	title: 'Save a secret',
	input: NoteInput,
	output: z.object({ ok: z.literal(true) }),
	requires: stashView.id,
	approval: 'never',
	async run(uow, { id, ...note }) {
		store.set(id, note);
		await uow.ai.reindex('stash.secret', id);
		return { ok: true as const };
	},
});

const pageOf = (kind: string, prefix: string) => async () => ({
	items: [...store.keys()].filter((id) => id.startsWith(prefix)).map((id) => ({ kind, id })),
	next: null,
});

const notes = defineTestExtension({
	id: 'notes',
	actions: [putNote, dropNote],
	capabilities: [notesView, notesAll],
	ai: {
		index: {
			kinds: {
				'notes.note': {
					capability: notesView.id,
					viewAll: notesAll.id,
					async load(_ctx, id) {
						const note = store.get(id);
						return note
							? {
									title: note.title,
									text: note.text,
									href: `/notes/${id}`,
									ownerMemberId: note.owner ?? null,
								}
							: null;
					},
				},
			},
			list: pageOf('notes.note', 'note_'),
		},
	},
});
const stash = defineTestExtension({
	id: 'stash',
	sensitive: true,
	actions: [putSecret],
	capabilities: [stashView],
	ai: {
		index: {
			kinds: {
				'stash.secret': {
					capability: stashView.id,
					async load(_ctx, id) {
						const note = store.get(id);
						return note ? { title: note.title, text: note.text, href: `/stash/${id}` } : null;
					},
				},
			},
			list: pageOf('stash.secret', 'secret_'),
		},
	},
});

let k: TestKernel;
const system = systemActor('test');

beforeEach(async () => {
	store.clear();
	k = await createTestKernel({ extensions: [notes, stash] });
	k.llm.embedModel = 'fake:embedder';
	await k.reconcileSearch();
	await k.worker.drain();
});
afterEach(() => k.close());

const put = async (id: string, title: string, text: string, owner?: string) => {
	await k.runner.invoke('notes.put', { id, title, text, owner }, system);
	await k.worker.drain();
};
const search = async (query: string, actor: Actor = system, limit = 5) => {
	const result = await k.runner.invoke<{
		results: { id: string; kind: string; extension: string; title: string; href: string | null }[];
	}>('core.searchFamily', { query, limit }, actor);
	if (result.status !== 'applied') throw new Error('expected a result');
	return result.output.results;
};
const ids = async (query: string, actor?: Actor) => (await search(query, actor)).map((r) => r.id);
const rows = async () =>
	k.ctx.db
		.selectFrom('core_embeddings' as never)
		.select(['source_id', 'chunk_index', 'model'] as never[])
		.execute() as unknown as Promise<{ source_id: string; chunk_index: number; model: string }[]>;
const area = (extensionId: string, access: 'off' | 'local' | 'any') =>
	k.runner.invoke('core.setAiAreaAccess', { extensionId, access, confirmSensitive: true }, system);
const aiFor = async (roleId: string, local = false) => {
	const { actor, member } = await k.member(roleId);
	const ai: Actor = {
		kind: 'ai',
		mode: 'conversation',
		source: 'assistant',
		onBehalfOf: member.id as MemberId,
		roleId,
		local,
	};
	return { member, actor, ai };
};

describe('indexing', () => {
	it('embeds on create, finds by meaning, ranks, and never re-embeds unchanged text', async () => {
		await put(
			'note_1',
			'Boiler warranty',
			'The boiler warranty runs until 2028. Call the plumber.',
		);
		await put('note_2', 'School trip', 'Zoo trip on Friday, bring a packed lunch.');
		await put('note_3', 'Pasta', 'Boil water, add salt and pasta.');
		expect(k.llm.embedCalls.filter((c) => c.feature === 'search.index')).toHaveLength(3);

		expect((await ids('boiler warranty'))[0]).toBe('note_1');
		expect((await ids('zoo trip friday lunch'))[0]).toBe('note_2');
		const first = (await search('boiler warranty'))[0];
		expect(first).toMatchObject({
			kind: 'notes.note',
			extension: 'notes',
			title: 'Boiler warranty',
			href: '/notes/note_1',
		});

		// The same text again: nothing goes to the model.
		const before = k.llm.embedCalls.length;
		await put(
			'note_1',
			'Boiler warranty',
			'The boiler warranty runs until 2028. Call the plumber.',
		);
		expect(k.llm.embedCalls).toHaveLength(before);
	});

	it('embeds only the chunks that changed', async () => {
		const paragraph = (word: string) => `${word} `.repeat(150).trim();
		const text = [paragraph('alpha'), paragraph('bravo'), paragraph('charlie')].join('\n\n');
		await put('note_1', 'Long', text);
		const stored = (await rows()).filter((r) => r.source_id === 'note_1');
		expect(stored.length).toBeGreaterThanOrEqual(3);

		const before = k.llm.embedCalls.length;
		await put('note_1', 'Long', `${text}\n\n${paragraph('delta')}`);
		const calls = k.llm.embedCalls.slice(before);
		const texts = calls.flatMap((c) => c.texts);
		expect(texts.length).toBeLessThan(stored.length + 2);
		expect(texts.some((t) => t.includes('delta'))).toBe(true);
		expect(texts.some((t) => t.includes('alpha alpha alpha alpha alpha alpha alpha alpha'))).toBe(
			false,
		);
	});

	it('forgets a note that is removed or no longer loads', async () => {
		await put('note_1', 'Boiler warranty', 'The boiler warranty runs until 2028.');
		expect(await rows()).not.toHaveLength(0);
		await k.runner.invoke('notes.drop', { id: 'note_1' }, system);
		expect(await rows()).toHaveLength(0);
		expect(await ids('boiler warranty')).toEqual([]);

		await put('note_2', 'Pasta', 'Boil water.');
		store.delete('note_2');
		await k.runner.invoke('notes.put', { id: 'note_3', title: 'x', text: 'y' }, system);
		store.delete('note_3');
		await k.worker.drain();
		expect((await rows()).map((r) => r.source_id)).not.toContain('note_3');
	});

	it('refuses an unknown kind', async () => {
		await expect(k.ctx.ai.reindex('nope.kind', 'x')).rejects.toThrow(/Unknown search kind/);
	});
});

describe('who finds what', () => {
	it('shows a member nothing of a kind they lack the capability for, the AI for them neither', async () => {
		await put('note_1', 'Boiler warranty', 'The boiler warranty runs until 2028.');
		const guest = await aiFor('guest');
		const member = await aiFor('member');
		expect(await ids('boiler warranty', guest.actor)).toEqual([]);
		expect(await ids('boiler warranty', guest.ai)).toEqual([]);
		expect(await ids('boiler warranty', member.actor)).toEqual(['note_1']);
		expect(await ids('boiler warranty', member.ai)).toEqual(['note_1']);
	});

	it('shows an owned note to its owner and to those who see everything, not to others', async () => {
		// Supervised members hold `notes.view` but not the edit-level `notes.viewAll`.
		const owner = await aiFor('supervised');
		const other = await aiFor('supervised');
		const admin = await aiFor('admin');
		await put('note_1', 'Boiler warranty', 'The boiler warranty runs until 2028.', owner.member.id);
		expect(await ids('boiler warranty', owner.actor)).toEqual(['note_1']);
		expect(await ids('boiler warranty', owner.ai)).toEqual(['note_1']);
		expect(await ids('boiler warranty', other.actor)).toEqual([]);
		expect(await ids('boiler warranty', other.ai)).toEqual([]);
		// `notes.viewAll` is an edit-level capability: the admin holds it, and so does the AI for them.
		expect(await ids('boiler warranty', admin.actor)).toEqual(['note_1']);
		expect(await ids('boiler warranty', admin.ai)).toEqual(['note_1']);
	});

	it('does not let the AI search for nobody', async () => {
		await put('note_1', 'Boiler warranty', 'The boiler warranty runs until 2028.');
		await expect(
			k.runner.invoke(
				'core.searchFamily',
				{ query: 'boiler' },
				{ kind: 'ai', mode: 'share', source: 'inbox' },
			),
		).rejects.toMatchObject({ code: 'forbidden' });
	});

	it('hands the route a path and the AI none', async () => {
		await put('note_1', 'Boiler warranty', 'The boiler warranty runs until 2028.');
		const { actor, ai } = await aiFor('member');
		const viaRoute = await k
			.route('core.searchFamily')
			.call({ query: { q: 'boiler warranty' }, actor });
		expect(viaRoute.results[0]).toMatchObject({ id: 'note_1', href: '/notes/note_1' });
		expect((await search('boiler warranty', ai))[0]?.href).toBeNull();
	});
});

describe('the AI sandbox', () => {
	it('deletes the vectors of an area that is turned off, and brings them back when it is on again', async () => {
		await put('note_1', 'Boiler warranty', 'The boiler warranty runs until 2028.');
		const { ai, actor } = await aiFor('member');
		expect(await ids('boiler warranty', ai)).toEqual(['note_1']);

		await area('notes', 'off');
		// Excluded at once, deleted once the follow-up job ran.
		expect(await ids('boiler warranty', ai)).toEqual([]);
		await k.worker.drain();
		expect(await rows()).toHaveLength(0);
		expect(await ids('boiler warranty', actor)).toEqual([]);

		await area('notes', 'any');
		await k.worker.drain();
		expect(await ids('boiler warranty', ai)).toEqual(['note_1']);
	});

	it('leaves a sensitive area out until the family opens it', async () => {
		await k.runner.invoke(
			'stash.put',
			{ id: 'secret_1', title: 'Passport', text: 'number' },
			system,
		);
		await k.worker.drain();
		expect(await rows()).toHaveLength(0);
		expect(await ids('passport number')).toEqual([]);

		await area('stash', 'any');
		await k.worker.drain();
		expect(await ids('passport number')).toEqual(['secret_1']);
	});

	it('embeds a local-only area only with a local embedding model, and shows it to local models only', async () => {
		await put('note_1', 'Boiler warranty', 'The boiler warranty runs until 2028.');
		await area('notes', 'local');
		await k.worker.drain();
		// The embedding model is not local: nothing may stay, and nothing is embedded.
		expect(await rows()).toHaveLength(0);
		const calls = k.llm.embedCalls.length;
		await put('note_2', 'Pasta', 'Boil water.');
		expect(k.llm.embedCalls).toHaveLength(calls);
		expect(await rows()).toHaveLength(0);

		k.llm.privacy.local = true;
		await k.reconcileSearch();
		await k.worker.drain();
		expect((await rows()).map((r) => r.source_id).sort()).toEqual(['note_1', 'note_2']);
		const remote = await aiFor('member', false);
		const local = await aiFor('member', true);
		expect(await ids('boiler warranty', remote.ai)).toEqual([]);
		expect(await ids('boiler warranty', local.ai)).toEqual(['note_1']);
		expect(await ids('boiler warranty', remote.actor)).toEqual(['note_1']);

		// Back to a model that is not local: the vectors go again.
		k.llm.privacy.local = false;
		await k.reconcileSearch();
		await k.worker.drain();
		expect(await rows()).toHaveLength(0);
	});
});

describe('models', () => {
	it('rebuilds the index when the embedding model changes', async () => {
		await put('note_1', 'Boiler warranty', 'The boiler warranty runs until 2028.');
		await put('note_2', 'Pasta', 'Boil water.');
		expect((await rows()).every((r) => r.model === 'fake:embedder')).toBe(true);

		k.llm.embedModel = 'fake:better';
		await k.reconcileSearch();
		await k.worker.drain();
		const after = await rows();
		expect(after.length).toBeGreaterThan(0);
		expect(after.every((r) => r.model === 'fake:better')).toBe(true);
		expect(await ids('boiler warranty')).toEqual(['note_1']);
		expect(k.llm.embedCalls.at(-1)?.feature).toBe('search');
	});

	it('builds the index of what existed before an embedding model was set', async () => {
		k.llm.embedModel = null;
		await k.reconcileSearch();
		await put('note_1', 'Boiler warranty', 'The boiler warranty runs until 2028.');
		expect(await rows()).toHaveLength(0);

		k.llm.embedModel = 'fake:embedder';
		await k.reconcileSearch();
		await k.worker.drain();
		expect(await ids('boiler warranty')).toEqual(['note_1']);
	});

	it('stops on an error a person must fix, records it, and does not retry in a loop', async () => {
		k.llm.embedError = new LlmError('auth', 'bad key');
		await k.runner.invoke('notes.put', { id: 'note_1', title: 'A', text: 'b' }, system);
		await k.worker.drain();
		expect(k.llm.embedCalls.filter((c) => c.feature === 'search.index')).toHaveLength(1);
		expect(await rows()).toHaveLength(0);
		const dead = await k.ctx.db
			.selectFrom('queue_jobs' as never)
			.select(['status'] as never[])
			.where('name' as never, '=', 'core.embed' as never)
			.execute();
		expect(dead).toEqual([{ status: 'succeeded' }]);
		expect(await k.route('core.searchStatus').call({ actor: system })).toMatchObject({
			error: 'auth',
		});

		// A person fixes it; the next change indexes and the failure is cleared.
		k.llm.embedError = null;
		await put('note_1', 'A', 'b changed');
		expect(await rows()).not.toHaveLength(0);
		expect(await k.route('core.searchStatus').call({ actor: system })).toMatchObject({
			error: null,
		});
	});

	it('retries a failure that may pass', async () => {
		k.llm.embedError = new LlmError('unavailable', 'down');
		await k.runner.invoke('notes.put', { id: 'note_1', title: 'A', text: 'b' }, system);
		await k.worker.drain();
		expect(await rows()).toHaveLength(0);
		const job = await k.ctx.db
			.selectFrom('queue_jobs' as never)
			.select(['status', 'attempts'] as never[])
			.where('name' as never, '=', 'core.embed' as never)
			.executeTakeFirstOrThrow();
		expect(job).toMatchObject({ status: 'pending', attempts: 1 });
	});
});

describe('configuration', () => {
	it('answers 409 not_configured and offers no tool without an embedding model', async () => {
		const { actor, ai } = await aiFor('member');
		const tools = () => k.ctx.actions.aiReadTools({ actor: ai }).map((t) => t.id);
		expect(tools()).toContain('core.searchFamily');

		k.llm.embedModel = null;
		await k.reconcileSearch();
		expect(tools()).not.toContain('core.searchFamily');
		await expect(search('boiler', actor)).rejects.toMatchObject({
			code: 'conflict',
			message: 'not_configured',
		});
		await expect(
			k.route('core.searchFamily').call({ query: { q: 'boiler' }, actor }),
		).rejects.toMatchObject({ code: 'conflict' });
		expect(await k.route('core.searchStatus').call({ actor })).toMatchObject({
			configured: false,
		});
	});

	it('reports which areas search covers', async () => {
		await area('notes', 'local');
		const status = await k.route('core.searchStatus').call({ actor: system });
		expect(status.configured).toBe(true);
		expect(status.areas).toEqual(
			expect.arrayContaining([
				{ id: 'notes', covered: false },
				{ id: 'stash', covered: false },
			]),
		);
		await area('notes', 'any');
		const again = await k.route('core.searchStatus').call({ actor: system });
		expect(again.areas).toEqual(expect.arrayContaining([{ id: 'notes', covered: true }]));
	});
});
