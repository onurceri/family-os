import { type Actor, defineAction, defineCapability, systemActor } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CoreTables } from '../src/tables.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

/**
 * Changes that arrive while an entity is being embedded: the queue folds their reindex into the
 * running job, so the job itself must end with rows that match the entity as it is then.
 */
type Paper = { title: string; text: string; capability: string; href: string };
const papers = new Map<string, Paper>();

const papersView = defineCapability({
	id: 'papers.view',
	label: 'papers:cap_view',
	level: 'view',
	defaults: { admin: true, member: true, supervised: true, guest: false },
});
const papersPrivate = defineCapability({
	id: 'papers.private',
	label: 'papers:cap_private',
	level: 'view',
	defaults: { admin: true, member: false, supervised: false, guest: false },
});

const putPaper = defineAction({
	id: 'papers.put',
	title: 'Save a paper',
	input: z.object({
		id: z.string(),
		title: z.string(),
		text: z.string(),
		capability: z.string(),
		href: z.string(),
	}),
	output: z.object({ ok: z.literal(true) }),
	requires: papersView.id,
	approval: 'never',
	async run(uow, { id, ...paper }) {
		papers.set(id, paper);
		await uow.ai.reindex('papers.paper', id);
		return { ok: true as const };
	},
});
const dropPaper = defineAction({
	id: 'papers.drop',
	title: 'Remove a paper',
	input: z.object({ id: z.string() }),
	output: z.object({ ok: z.literal(true) }),
	requires: papersView.id,
	approval: 'never',
	async run(uow, { id }) {
		papers.delete(id);
		await uow.ai.remove('papers.paper', id);
		return { ok: true as const };
	},
});

const extension = defineTestExtension({
	id: 'papers',
	actions: [putPaper, dropPaper],
	capabilities: [papersView, papersPrivate],
	ai: {
		index: {
			kinds: {
				'papers.paper': {
					capability: papersView.id,
					async load(_ctx, id) {
						const paper = papers.get(id);
						const read = paper ? { ...paper } : null;
						await afterRead?.(read);
						return read;
					},
				},
			},
			list: async () => ({
				items: [...papers.keys()].map((id) => ({ kind: 'papers.paper', id })),
				next: null,
			}),
		},
	},
});

const MODEL = 'fake:embedder';
const system = systemActor('test');

/** The index model's calls; `hold()` keeps the next one open until `release()`. */
let indexTexts: string[][];
type Hold = { started: Promise<void>; start(): void; released: Promise<void>; release(): void };
let held: Hold | null;
/** Runs after the index read a paper and before it gets what was read. */
let afterRead: ((read: Paper | null) => Promise<void>) | null;
let k: TestKernel;

beforeEach(async () => {
	papers.clear();
	indexTexts = [];
	held = null;
	afterRead = null;
	k = await createTestKernel({
		extensions: [extension],
		llm: {
			policy: async () => ({
				enabled: true,
				sendFiles: true,
				sendPeople: true,
				sendVoice: true,
				local: false,
				model: MODEL,
			}),
			embed: async (request) => {
				if (request.feature === 'search.index') {
					indexTexts.push([...request.texts]);
					const hold = held;
					held = null;
					if (hold) {
						hold.start();
						await hold.released;
					}
				}
				const vector = Float32Array.from([1, 0, 0, 0]);
				return { vectors: request.texts.map(() => vector), model: MODEL, dimensions: 4 };
			},
		},
	});
	// The first index build (of nothing yet), so only the jobs a test starts are left to run.
	await k.worker.drain();
});
afterEach(() => k.close());

/** Holds the next index call open; `started` resolves once the job is inside it. */
function hold(): Hold {
	let start = () => {};
	let release = () => {};
	const started = new Promise<void>((resolve) => {
		start = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	held = { started, start, released, release };
	return held;
}

const paper = (over: Partial<Paper> = {}): Paper => ({
	title: 'Boiler warranty',
	text: 'The boiler warranty runs until 2028.',
	capability: papersView.id,
	href: '/papers/p1',
	...over,
});
const put = (id: string, value: Paper) => k.runner.invoke('papers.put', { id, ...value }, system);
const rows = () =>
	k.ctx.db
		.withTables<CoreTables>()
		.selectFrom('core_embeddings')
		.select(['source_id', 'capability', 'href', 'title', 'snippet'])
		.where('source_kind', '=', 'papers.paper')
		.execute();
const search = async (actor: Actor) => {
	const result = await k.runner.invoke<{ results: { id: string }[] }>(
		'core.searchFamily',
		{ query: 'boiler', limit: 5 },
		actor,
	);
	if (result.status !== 'applied') throw new Error('expected a result');
	return result.output.results.map((r) => r.id);
};

/** Starts the queued embedding, holds the model call open, runs `during`, then lets it finish. */
async function whileEmbedding(during: () => Promise<unknown>) {
	const gate = hold();
	const draining = k.worker.drain();
	await gate.started;
	await during();
	gate.release();
	await draining;
}

describe('a change while an entity is being embedded', () => {
	it('ends with the new audience on every row', async () => {
		const { actor } = await k.member('member');
		const long = paper({ text: 'The boiler warranty runs until 2028. '.repeat(200) });
		await put('p1', long);

		await whileEmbedding(() => put('p1', { ...long, capability: papersPrivate.id }));
		await k.worker.drain();

		const stored = await rows();
		expect(stored.length).toBeGreaterThan(0);
		expect(stored.every((r) => r.capability === papersPrivate.id)).toBe(true);
		expect(await search(actor)).toEqual([]);
		expect(await search(system)).toEqual(['p1']);
	});

	it('takes a moved link and a renamed-only change without asking the model again', async () => {
		await put('p1', paper());
		await whileEmbedding(() => put('p1', paper({ href: '/papers/p1/moved' })));
		await k.worker.drain();

		expect(indexTexts).toHaveLength(1);
		expect(await rows()).toEqual([expect.objectContaining({ href: '/papers/p1/moved' })]);
	});

	it('leaves nothing behind for an entity removed meanwhile', async () => {
		await put('p1', paper());

		await whileEmbedding(() => k.runner.invoke('papers.drop', { id: 'p1' }, system));
		await k.worker.drain();

		expect(await rows()).toEqual([]);
		expect(await search(system)).toEqual([]);
	});

	it('embeds again when the text changed meanwhile', async () => {
		await put('p1', paper());

		await whileEmbedding(() => put('p1', paper({ text: 'The boiler was replaced in 2030.' })));
		await k.worker.drain();

		expect(indexTexts).toHaveLength(2);
		expect(indexTexts[1]?.[0]).toContain('replaced in 2030');
		expect(await rows()).toEqual([
			expect.objectContaining({ snippet: 'The boiler was replaced in 2030.' }),
		]);
	});

	it('settles on the last of several changes', async () => {
		const { actor } = await k.member('member');
		await put('p1', paper());

		await whileEmbedding(async () => {
			await put('p1', paper({ capability: papersPrivate.id }));
			await put('p1', paper({ capability: papersPrivate.id, href: '/papers/p1/a' }));
			await put('p1', paper({ capability: papersPrivate.id, href: '/papers/p1/b' }));
		});
		await k.worker.drain();

		expect(indexTexts).toHaveLength(1);
		expect(await rows()).toEqual([
			expect.objectContaining({ capability: papersPrivate.id, href: '/papers/p1/b' }),
		]);
		expect(await search(actor)).toEqual([]);
	});

	it('catches a change made just after its last read', async () => {
		const { actor } = await k.member('member');
		await put('p1', paper());
		// Once the index matches what was read, the paper moves before the job hears back.
		afterRead = async (read) => {
			const stored = await rows();
			if (stored.length === 0 || stored.some((r) => r.capability !== read?.capability)) return;
			afterRead = null;
			await put('p1', paper({ capability: papersPrivate.id }));
		};
		await k.worker.drain();

		expect(afterRead).toBeNull();
		expect(indexTexts).toHaveLength(1);
		expect(await rows()).toEqual([expect.objectContaining({ capability: papersPrivate.id })]);
		expect(await search(actor)).toEqual([]);
	});

	it('gives up for now on a paper that changes at every read, and tries again later', async () => {
		await put('p1', paper());
		let reads = 0;
		afterRead = async () => {
			reads++;
			papers.set('p1', paper({ href: `/papers/p1/${reads}` }));
		};
		await k.worker.drain();

		expect(reads).toBeLessThan(20);
		expect(indexTexts).toHaveLength(1);
		const job = await k.ctx.db
			.selectFrom('queue_jobs' as never)
			.select(['status', 'last_error'] as never[])
			.where('name' as never, '=', 'core.embed' as never)
			.executeTakeFirst();
		expect(job).toMatchObject({
			status: 'pending',
			last_error: expect.stringContaining('kept changing'),
		});

		afterRead = null;
		k.clock.advance(60 * 60_000);
		await k.worker.drain();
		expect(indexTexts).toHaveLength(1);
		expect(await rows()).toEqual([expect.objectContaining({ href: `/papers/p1/${reads}` })]);
	});
});
