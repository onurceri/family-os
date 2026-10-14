import { openDatabase } from '@famos/db';
import type { DbExecutor } from '@famos/sdk';
import { type KyselyPlugin, OperationNodeTransformer, sql } from 'kysely';
import { expect, it } from 'vitest';
import { createSchemaNames, scopePlugin } from '../src/scope.ts';

/**
 * What keeping an extension to its tables costs per query: a representative set of extension
 * queries (a filtered list with a join and an order, a lookup by id, an insert, an update, a
 * delete, a count, raw `order by`), compiled and run many times with and without the scope plugin,
 * and with a plugin that rebuilds the tree (Kysely's transformer) for comparison. Skipped unless
 * FAMOS_BENCH=1: `FAMOS_BENCH=1 pnpm vitest run packages/core/test/scope-bench.test.ts`.
 */
type Tables = {
	bench_items: {
		id: string;
		list_id: string;
		title: string;
		quantity: string | null;
		done_at: number | null;
		sort: number;
		created_at: number;
	};
	bench_lists: { id: string; name: string; sort: number };
};

/** Rebuilds every node, the way a plugin built on `OperationNodeTransformer` does. */
class Rebuild extends OperationNodeTransformer {}
const rebuilding: KyselyPlugin = {
	transformQuery: ({ node }) => new Rebuild().transformNode(node),
	transformResult: async ({ result }) => result,
};

const queries = (db: DbExecutor, i: number) => {
	const t = db.withTables<Tables>();
	return [
		t
			.selectFrom('bench_items as i')
			.innerJoin('bench_lists as l', 'l.id', 'i.list_id')
			.select(['i.id', 'i.title', 'i.quantity', 'l.name'])
			.where('i.list_id', '=', 'list_1')
			.where('i.done_at', 'is', null)
			.orderBy(sql`i.done_at is not null`)
			.orderBy('i.sort')
			.limit(50),
		t
			.selectFrom('bench_items')
			.selectAll()
			.where('id', '=', `item_${i % 100}`),
		t.insertInto('bench_items').values({
			id: `new_${i}`,
			list_id: 'list_1',
			title: 'Milk',
			quantity: '2',
			done_at: null,
			sort: i,
			created_at: i,
		}),
		t.updateTable('bench_items').set({ done_at: i }).where('id', '=', `new_${i}`),
		t.deleteFrom('bench_items').where('id', '=', `new_${i}`),
		t
			.selectFrom('bench_items')
			.select((eb) => eb.fn.countAll<number>().as('n'))
			.where('list_id', '=', 'list_1'),
	];
};

function time(rounds: number, work: (i: number) => void): number {
	for (let i = 0; i < 200; i++) work(i);
	const started = performance.now();
	for (let i = 0; i < rounds; i++) work(i);
	return ((performance.now() - started) * 1000) / rounds;
}

async function timeAsync(rounds: number, work: (i: number) => Promise<void>): Promise<number> {
	for (let i = 0; i < 200; i++) await work(i);
	const started = performance.now();
	for (let i = 0; i < rounds; i++) await work(i);
	return ((performance.now() - started) * 1000) / rounds;
}

it.skipIf(!process.env.FAMOS_BENCH)('costs little per query', async () => {
	const { db, close } = openDatabase({ path: ':memory:' });
	await sql`create table bench_lists (id text primary key, name text not null, sort integer not null)`.execute(
		db,
	);
	await sql`create table bench_items (id text primary key, list_id text not null, title text not null,
		quantity text, done_at integer, sort integer not null, created_at integer not null)`.execute(
		db,
	);
	await sql`insert into bench_lists values ('list_1', 'Shopping', 0)`.execute(db);
	for (let i = 0; i < 100; i++)
		await sql`insert into bench_items values (${`item_${i}`}, 'list_1', ${`Item ${i}`}, null, null, ${i}, ${i})`.execute(
			db,
		);
	const names = createSchemaNames();
	await names.refresh(db);
	const scoped = db.withPlugin(scopePlugin('bench', 'bench_', names));
	const rebuilt = db.withPlugin(rebuilding);
	const n = queries(db, 0).length;

	const rounds = 20_000;
	const compile = (target: DbExecutor) =>
		time(rounds, (i) => {
			for (const q of queries(target, i)) q.compile();
		}) / n;
	const run = async (target: DbExecutor) =>
		(await timeAsync(rounds / 4, async (i) => {
			for (const q of queries(target, i)) await q.execute();
		})) / n;

	const results = {
		compilePlain: compile(db),
		compileScoped: compile(scoped),
		compileRebuilt: compile(rebuilt),
		runPlain: await run(db),
		runScoped: await run(scoped),
	};
	console.log(
		[
			`scope benchmark (µs per query, ${n} query shapes):`,
			`  compile: plain ${results.compilePlain.toFixed(2)}, scoped ${results.compileScoped.toFixed(2)} (+${(results.compileScoped - results.compilePlain).toFixed(2)}), transformer ${results.compileRebuilt.toFixed(2)} (+${(results.compileRebuilt - results.compilePlain).toFixed(2)})`,
			`  run:     plain ${results.runPlain.toFixed(2)}, scoped ${results.runScoped.toFixed(2)} (+${(results.runScoped - results.runPlain).toFixed(2)})`,
		].join('\n'),
	);
	expect(results.compileScoped).toBeGreaterThan(0);
	await close();
});
