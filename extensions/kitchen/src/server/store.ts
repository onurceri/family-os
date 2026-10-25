import type { DbExecutor, Migrations } from '@famos/sdk';
import { sql } from 'kysely';
import type { MealEntry, MealSlot, Recipe, RecipeSummary } from '../contract/index.ts';

/** Storage for the kitchen (tables prefixed `kitchen_`). */
export type KitchenTables = {
	kitchen_recipes: {
		id: string;
		title: string;
		servings: string | null;
		total_minutes: number | null;
		/** JSON array of free-text lines. */
		ingredients: string;
		/** JSON array of texts. */
		steps: string;
		notes: string | null;
		source_url: string | null;
		/** Key of the photo in the file store. */
		photo_key: string | null;
		photo_type: string | null;
		/** JSON array of short labels. */
		tags: string;
		/** The title lower-cased in TypeScript (SQLite folds only ASCII): what a search compares. */
		title_key: string;
		/** JSON array of the tags lower-cased the same way. */
		tags_key: string;
		created_by: string | null;
		created_at: number;
		updated_at: number;
		archived_at: number | null;
	};
	kitchen_meal_plan: {
		id: string;
		date: string;
		slot: MealSlot;
		recipe_id: string | null;
		title: string;
		note: string | null;
		created_by: string | null;
		created_at: number;
		updated_at: number;
	};
};
export type RecipeRow = KitchenTables['kitchen_recipes'];
/** The columns a list of recipes needs; the ingredients and steps stay in the database. */
export type RecipeSummaryRow = Pick<
	RecipeRow,
	'id' | 'title' | 'servings' | 'total_minutes' | 'photo_key' | 'tags' | 'updated_at'
>;
export type MealRow = KitchenTables['kitchen_meal_plan'];

export const migrations: Migrations = {
	'0001_init': {
		async up(db) {
			await db.schema
				.createTable('kitchen_recipes')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('title', 'text', (c) => c.notNull())
				.addColumn('servings', 'text')
				.addColumn('total_minutes', 'integer')
				.addColumn('ingredients', 'text', (c) => c.notNull().defaultTo('[]'))
				.addColumn('steps', 'text', (c) => c.notNull().defaultTo('[]'))
				.addColumn('notes', 'text')
				.addColumn('source_url', 'text')
				.addColumn('photo_key', 'text')
				.addColumn('photo_type', 'text')
				.addColumn('tags', 'text', (c) => c.notNull().defaultTo('[]'))
				.addColumn('created_by', 'text')
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.addColumn('updated_at', 'integer', (c) => c.notNull())
				.addColumn('archived_at', 'integer')
				.modifyEnd(sql`strict`)
				.execute();
			await db.schema
				.createIndex('kitchen_recipes_active_idx')
				.on('kitchen_recipes')
				.columns(['archived_at', 'title'])
				.execute();

			await db.schema
				.createTable('kitchen_meal_plan')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('date', 'text', (c) => c.notNull())
				.addColumn('slot', 'text', (c) => c.notNull().defaultTo('dinner'))
				.addColumn('recipe_id', 'text', (c) => c.references('kitchen_recipes.id'))
				.addColumn('title', 'text', (c) => c.notNull().defaultTo(''))
				.addColumn('note', 'text')
				.addColumn('created_by', 'text')
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.addColumn('updated_at', 'integer', (c) => c.notNull())
				.modifyEnd(sql`strict`)
				.execute();
			await db.schema
				.createIndex('kitchen_meal_plan_date_idx')
				.on('kitchen_meal_plan')
				.columns(['date', 'slot'])
				.execute();
		},
	},
	// Searching compares the folded title and tags in the database, so it no longer reads every
	// recipe into memory. Recipes saved before are folded here.
	'0002_search_keys': {
		async up(db) {
			await db.schema
				.alterTable('kitchen_recipes')
				.addColumn('title_key', 'text', (c) => c.notNull().defaultTo(''))
				.execute();
			await db.schema
				.alterTable('kitchen_recipes')
				.addColumn('tags_key', 'text', (c) => c.notNull().defaultTo('[]'))
				.execute();
			const rows = await tables(db)
				.selectFrom('kitchen_recipes')
				.select(['id', 'title', 'tags'])
				.execute();
			for (const row of rows)
				await tables(db)
					.updateTable('kitchen_recipes')
					.set(searchKeys(row.title, JSON.parse(row.tags) as string[]))
					.where('id', '=', row.id)
					.execute();
			await db.schema
				.createIndex('kitchen_recipes_title_key_idx')
				.on('kitchen_recipes')
				.columns(['archived_at', 'title_key'])
				.execute();
		},
	},
};

/** What a recipe search compares: the title and the tags, lower-cased for any script. */
export const searchKeys = (title: string, tags: readonly string[]) => ({
	title_key: title.toLocaleLowerCase(),
	tags_key: JSON.stringify(tags.map((t) => t.toLocaleLowerCase())),
});

export const tables = (db: DbExecutor) => db.withTables<KitchenTables>();

const list = (json: string) => JSON.parse(json) as string[];

export function toRecipe(row: RecipeRow): Recipe {
	return {
		id: row.id,
		title: row.title,
		servings: row.servings,
		totalMinutes: row.total_minutes,
		ingredients: list(row.ingredients),
		steps: list(row.steps),
		notes: row.notes,
		sourceUrl: row.source_url,
		hasPhoto: row.photo_key !== null,
		tags: list(row.tags),
		createdBy: row.created_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function toRecipeSummary(row: RecipeSummaryRow): RecipeSummary {
	return {
		id: row.id,
		title: row.title,
		servings: row.servings,
		totalMinutes: row.total_minutes,
		hasPhoto: row.photo_key !== null,
		tags: list(row.tags),
		updatedAt: row.updated_at,
	};
}

export function toMeal(row: MealRow, recipeTitle: string | null): MealEntry {
	return {
		id: row.id,
		date: row.date,
		slot: row.slot,
		recipeId: row.recipe_id,
		title: recipeTitle ?? row.title,
		note: row.note,
		createdAt: row.created_at,
	};
}
