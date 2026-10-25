import { openDatabase, runMigrations, type TestKernel } from '@famos/testing';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Recipe, RecipeSummary } from '../src/contract/index.ts';
import { migrations, searchKeys, tables } from '../src/server/store.ts';
import { applied, createKernel, type Person, person } from './support.ts';

let k: TestKernel;
let admin: Person;

beforeEach(async () => {
	k = await createKernel();
	admin = await person(k, 'admin', 'Ayşe');
});
afterEach(() => k.close());

const add = (title: string, tags: string[] = []) =>
	applied<Recipe>(
		k,
		'kitchen.createRecipe',
		{ title, ingredients: ['1 onion'], steps: ['Cook.'], tags },
		admin.actor,
	);
const search = (query: Record<string, unknown>): Promise<RecipeSummary[]> =>
	k.route('kitchen.searchRecipes').call({ query, actor: admin.actor });

describe('searching recipes', () => {
	it('finds titles and tags in any script regardless of case', async () => {
		await add('Mercimek Çorbası', ['Çorba']);
		await add('Σούπα φακής', ['ΣΟΥΠΑ']);
		await add('Apple pie');

		expect((await search({ q: 'ÇORBA' })).map((r) => r.title)).toEqual(['Mercimek Çorbası']);
		expect((await search({ q: 'çorbası' })).map((r) => r.title)).toEqual(['Mercimek Çorbası']);
		expect((await search({ q: 'ΦΑΚΉΣ' })).map((r) => r.title)).toEqual(['Σούπα φακής']);
		expect((await search({ tag: 'çorba' })).map((r) => r.title)).toEqual(['Mercimek Çorbası']);
		expect((await search({ tag: 'σουπα' })).map((r) => r.title)).toEqual(['Σούπα φακής']);
	});

	it('takes % and _ in a search as plain characters', async () => {
		await add('100% juice');
		await add('Plain juice');
		await add('Soup_of_day');
		expect((await search({ q: '100%' })).map((r) => r.title)).toEqual(['100% juice']);
		expect((await search({ q: '_' })).map((r) => r.title)).toEqual(['Soup_of_day']);
		expect((await search({ q: '%' })).map((r) => r.title)).toEqual(['100% juice']);
	});

	it('follows a renamed recipe and its changed tags', async () => {
		const recipe = await add('Tomato soup', ['soup']);
		await applied(
			k,
			'kitchen.updateRecipe',
			{
				id: recipe.id,
				recipe: {
					title: 'Pepper stew',
					servings: null,
					totalMinutes: null,
					ingredients: ['1 onion'],
					steps: ['Cook.'],
					notes: null,
					sourceUrl: null,
					tags: ['stew'],
				},
			},
			admin.actor,
		);
		expect(await search({ q: 'tomato' })).toEqual([]);
		expect(await search({ tag: 'soup' })).toEqual([]);
		expect((await search({ q: 'PEPPER', tag: 'Stew' })).map((r) => r.title)).toEqual([
			'Pepper stew',
		]);
	});

	it('finds a recipe past the thousandth and limits an assistant list', async () => {
		const now = Date.now();
		const db = tables(k.ctx.db);
		const rows = Array.from({ length: 1005 }, (_, i) => {
			const title = `Recipe ${String(i).padStart(4, '0')}`;
			return {
				id: `kitchen_recipe_bulk${i}`,
				title,
				...searchKeys(title, []),
				servings: null,
				total_minutes: null,
				ingredients: '[]',
				steps: '[]',
				notes: null,
				source_url: null,
				photo_key: null,
				photo_type: null,
				tags: '[]',
				created_by: null,
				created_at: now,
				updated_at: now,
				archived_at: null,
			};
		});
		for (let i = 0; i < rows.length; i += 100)
			await db
				.insertInto('kitchen_recipes')
				.values(rows.slice(i, i + 100))
				.execute();

		expect(await search({})).toHaveLength(1005);
		expect((await search({ q: 'recipe 1004' })).map((r) => r.title)).toEqual(['Recipe 1004']);
		const listed = await applied<{ recipes: { title: string }[] }>(
			k,
			'kitchen.listRecipes',
			{ query: 'recipe 0' },
			admin.actor,
		);
		expect(listed.recipes).toHaveLength(30);
	});
});

describe('upgrading a database from before the search keys', () => {
	it('folds the titles and tags of the recipes already saved', async () => {
		const handle = openDatabase({ path: ':memory:' });
		const { db } = handle;
		const released = Object.fromEntries(
			Object.entries(migrations).filter(([n]) => n === '0001_init'),
		);
		await runMigrations(db, [{ scope: 'kitchen', migrations: released }]);
		await sql`insert into kitchen_recipes (id, title, tags, created_at, updated_at)
			values ('r1', 'Mercimek Çorbası', '["Çorba","Soup"]', 1, 1), ('r2', 'Pie', '[]', 1, 1)`.execute(
			db,
		);

		await runMigrations(db, [{ scope: 'kitchen', migrations }]);

		const { rows } = await sql<{ id: string; title_key: string; tags_key: string }>`
			select id, title_key, tags_key from kitchen_recipes order by id`.execute(db);
		expect(rows).toEqual([
			{ id: 'r1', title_key: 'mercimek çorbası', tags_key: '["çorba","soup"]' },
			{ id: 'r2', title_key: 'pie', tags_key: '[]' },
		]);
		await handle.close();
	});
});
