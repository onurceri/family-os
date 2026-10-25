import { defineCapability } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalize } from '../src/search.ts';
import type { CoreTables } from '../src/tables.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

const notesView = defineCapability({
	id: 'notes.view',
	label: 'notes:cap_view',
	level: 'view',
	defaults: { admin: true, member: true, supervised: true, guest: false },
});

const notes = defineTestExtension({
	id: 'notes',
	capabilities: [notesView],
	ai: {
		index: {
			kinds: {
				'notes.note': {
					capability: notesView.id,
					load: async () => null,
				},
			},
			list: async () => ({ items: [], next: null }),
		},
	},
});

const MODEL = 'fake:embedder';
const QUESTION = normalize(Float32Array.from([1, 0, 0, 0]));

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel({
		extensions: [notes],
		llm: {
			policy: async () => ({
				enabled: true,
				sendFiles: true,
				sendPeople: true,
				sendVoice: true,
				local: false,
				model: MODEL,
			}),
			embed: async () => ({ vectors: [QUESTION], model: MODEL, dimensions: 4 }),
		},
	});
});
afterEach(() => k.close());

/** Stores chunks straight into the index: `score` is how close each is to the question. */
type Chunk = { id: string; source: string; score: number; owner?: string; index?: number };

async function store(chunks: Chunk[]) {
	const rows = chunks.map((chunk) => ({
		id: chunk.id,
		extension_id: 'notes',
		source_kind: 'notes.note',
		source_id: chunk.source,
		capability: notesView.id,
		owner_member_id: chunk.owner ?? null,
		title: `Title ${chunk.source}`,
		href: `/notes/${chunk.source}`,
		snippet: `Snippet ${chunk.id}`,
		model: MODEL,
		dimensions: 4,
		text_hash: 'h',
		chunk_index: chunk.index ?? 0,
		vector: new Uint8Array(
			normalize(
				Float32Array.from([chunk.score, Math.sqrt(Math.max(0, 1 - chunk.score ** 2)), 0, 0]),
			).buffer,
		),
		updated_at: 1,
	}));
	for (let i = 0; i < rows.length; i += 500)
		await k.ctx.db
			.withTables<CoreTables>()
			.insertInto('core_embeddings')
			.values(rows.slice(i, i + 500))
			.execute();
}

describe('family search', () => {
	it('scores the index outside the transaction and answers as before', async () => {
		const { actor, member } = await k.member('member');
		const { member: other } = await k.member('member');
		// More than a page of chunks, most of them far from the question.
		const chunks: Chunk[] = Array.from({ length: 4500 }, (_, i) => ({
			id: `emb_${String(i).padStart(5, '0')}`,
			source: `note_${i}`,
			score: 0.1 + (i % 50) / 1000,
		}));
		// The best: two chunks of one note, another member's private note, and one of the asker's.
		chunks.push({ id: 'emb_a1', source: 'note_best', score: 0.99 });
		chunks.push({ id: 'emb_a2', source: 'note_best', score: 0.98, index: 1 });
		chunks.push({ id: 'emb_b', source: 'note_private', score: 0.97, owner: other.id });
		chunks.push({ id: 'emb_c', source: 'note_mine', score: 0.96, owner: member.id });
		chunks.push({ id: 'emb_d', source: 'note_next', score: 0.95 });
		await store(chunks);

		const seen: { sql: string; inTransaction: boolean }[] = [];
		const prepare = k.sqlite.prepare.bind(k.sqlite);
		k.sqlite.prepare = ((source: string) => {
			if (source.includes('from "core_embeddings"'))
				seen.push({ sql: source, inTransaction: k.sqlite.inTransaction });
			return prepare(source);
		}) as typeof k.sqlite.prepare;
		let result: Awaited<ReturnType<TestKernel['runner']['invoke']>>;
		try {
			result = await k.runner.invoke('core.searchFamily', { query: 'boiler', limit: 3 }, actor);
		} finally {
			k.sqlite.prepare = prepare;
		}

		if (result.status !== 'applied') throw new Error('expected results');
		expect(
			(result.output as { results: { id: string; snippet: string; href: string }[] }).results,
		).toEqual([
			expect.objectContaining({
				id: 'note_best',
				snippet: 'Snippet emb_a1',
				href: '/notes/note_best',
			}),
			expect.objectContaining({ id: 'note_mine', title: 'Title note_mine' }),
			expect.objectContaining({ id: 'note_next' }),
		]);
		const scans = seen.filter((s) => s.sql.includes('"vector"'));
		// Every page of vectors is read with no transaction open; the read inside it is small.
		expect(scans.length).toBeGreaterThanOrEqual(3);
		expect(scans.every((s) => !s.inTransaction)).toBe(true);
		const inside = seen.filter((s) => s.inTransaction);
		expect(inside).toHaveLength(1);
		expect(inside[0]?.sql).not.toContain('"vector"');
	});
});
