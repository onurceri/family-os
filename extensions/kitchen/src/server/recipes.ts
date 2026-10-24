import {
	defineAction,
	defineRoute,
	FamosError,
	FileResponseSchema,
	readUploadedImage,
	selfOf,
	storedAsWhole,
	storeThenRun,
	type UnitOfWork,
	uploadRequestLimit,
} from '@famos/sdk';
import { z } from 'zod';
import {
	CreateRecipeSchema,
	RecipeFieldsSchema,
	RecipeIdSchema,
	RecipeSchema,
	RecipeSummarySchema,
	UpdateRecipeSchema,
} from '../contract/index.ts';
import { kitchenChanged, kitchenEdit, kitchenView } from './capabilities.ts';
import { RECIPE_KIND } from './search.ts';
import { type RecipeRow, tables, toRecipe, toRecipeSummary } from './store.ts';

export const memberId = selfOf;

export async function loadRecipe(db: UnitOfWork['db'], id: string): Promise<RecipeRow> {
	const row = await tables(db)
		.selectFrom('kitchen_recipes')
		.selectAll()
		.where('id', '=', id)
		.where('archived_at', 'is', null)
		.executeTakeFirst();
	if (!row) throw new FamosError('not_found', 'Recipe not found');
	return row;
}

const fieldsOf = (r: z.output<typeof CreateRecipeSchema>) => ({
	title: r.title,
	servings: r.servings || null,
	total_minutes: r.totalMinutes ?? null,
	ingredients: JSON.stringify(r.ingredients),
	steps: JSON.stringify(r.steps),
	notes: r.notes || null,
	source_url: r.sourceUrl || null,
	tags: JSON.stringify([...new Set(r.tags)]),
});

async function insertRecipe(
	uow: UnitOfWork,
	input: z.output<typeof CreateRecipeSchema>,
): Promise<RecipeRow> {
	const now = uow.clock.now();
	const row: RecipeRow = {
		id: uow.ids.next('recipe'),
		...fieldsOf(input),
		photo_key: null,
		photo_type: null,
		created_by: memberId(uow.actor),
		created_at: now,
		updated_at: now,
		archived_at: null,
	};
	await tables(uow.db).insertInto('kitchen_recipes').values(row).execute();
	await uow.ai.reindex(RECIPE_KIND, row.id);
	uow.emit(kitchenChanged, { area: 'recipes', id: row.id });
	return row;
}

const sameTitle = async (db: UnitOfWork['db'], title: string) =>
	(await tables(db)
		.selectFrom('kitchen_recipes')
		.select('id')
		.where('archived_at', 'is', null)
		.where('title', '=', title)
		.executeTakeFirst()) !== undefined;

export const createRecipe = defineAction({
	id: 'kitchen.createRecipe',
	title: 'Add a recipe',
	draftTitle: 'kitchen:draft_title_create_recipe',
	input: CreateRecipeSchema,
	output: RecipeSchema,
	approval: { unless: kitchenEdit.id },
	undo: (recipe) => ({ actionId: 'kitchen.archiveRecipe', input: { id: recipe.id } }),
	ai: {
		description:
			'Save a recipe the family shared (a photo of a recipe, a page, a message with a recipe) so it can be cooked later: title, ingredients and steps.',
		guidance:
			'Keep the original language. One ingredient per entry, exactly as written with its amount ("2 cups flour", "1 kg tomato"); do not convert or merge units. One step per entry, in order, without numbering. servings and totalMinutes only when stated. sourceUrl only when the recipe’s web address is given.',
	},
	async alreadyThere(ctx, input) {
		return sameTitle(ctx.db, input.title);
	},
	async run(uow, input) {
		return toRecipe(await insertRecipe(uow, input));
	},
});

export const updateRecipe = defineAction({
	id: 'kitchen.updateRecipe',
	target: ({ id }) => ({ table: 'kitchen_recipes', id, liveColumn: 'archived_at' }),
	title: 'Change a recipe',
	draftTitle: 'kitchen:draft_title_update_recipe',
	input: UpdateRecipeSchema,
	// Waiting from when a field left out meant empty (or its default): read that way.
	storedInput: storedAsWhole(RecipeFieldsSchema, 'recipe'),
	output: RecipeSchema,
	approval: { unless: kitchenEdit.id },
	async run(uow, { id, recipe }) {
		const row = await loadRecipe(uow.db, id);
		const patch = { ...fieldsOf(recipe), updated_at: uow.clock.now() };
		await tables(uow.db).updateTable('kitchen_recipes').set(patch).where('id', '=', id).execute();
		await uow.ai.reindex(RECIPE_KIND, id);
		uow.emit(kitchenChanged, { area: 'recipes', id });
		return toRecipe({ ...row, ...patch });
	},
});

/** Hides a recipe (kept, so meal plan entries that name it still read well). */
export const archiveRecipe = defineAction({
	id: 'kitchen.archiveRecipe',
	target: ({ id }) => ({ table: 'kitchen_recipes', id, liveColumn: 'archived_at' }),
	title: 'Archive a recipe',
	draftTitle: 'kitchen:draft_title_archive_recipe',
	input: z.object({ id: RecipeIdSchema }),
	output: z.object({ ok: z.literal(true) }),
	approval: { unless: kitchenEdit.id },
	async run(uow, { id }) {
		const row = await tables(uow.db)
			.selectFrom('kitchen_recipes')
			.select('archived_at')
			.where('id', '=', id)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', 'Recipe not found');
		// Already archived: nothing to do (undoing twice, a second tap).
		if (row.archived_at === null) {
			const now = uow.clock.now();
			await tables(uow.db)
				.updateTable('kitchen_recipes')
				.set({ archived_at: now, updated_at: now })
				.where('id', '=', id)
				.execute();
			await uow.ai.remove(RECIPE_KIND, id);
			uow.emit(kitchenChanged, { area: 'recipes', id, op: 'delete' });
		}
		return { ok: true as const };
	},
});

/** Stores the photo the upload route already put in the file store. */
export const setRecipePhoto = defineAction({
	id: 'kitchen.setRecipePhoto',
	target: ({ id }) => ({ table: 'kitchen_recipes', id, liveColumn: 'archived_at' }),
	title: 'Set a recipe photo',
	input: z.object({
		id: RecipeIdSchema,
		// Only keys the upload route makes: the action is also reachable at /actions.
		key: z.string().regex(/^kitchen\/recipes\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/),
		type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
	}),
	output: z.object({ previousKey: z.string().nullable() }),
	requires: kitchenEdit.id,
	approval: 'never',
	async run(uow, { id, key, type }) {
		if (!key.startsWith(`kitchen/recipes/${id}/`))
			throw new FamosError('bad_request', 'The photo belongs to another recipe');
		const row = await loadRecipe(uow.db, id);
		await tables(uow.db)
			.updateTable('kitchen_recipes')
			.set({ photo_key: key, photo_type: type, updated_at: uow.clock.now() })
			.where('id', '=', id)
			.execute();
		uow.emit(kitchenChanged, { area: 'recipes', id });
		return { previousKey: row.photo_key };
	},
});

/** The recipes shown in a list, optionally narrowed by a title search and a tag. */
export async function searchRecipes(
	db: UnitOfWork['db'],
	options: { q?: string | undefined; tag?: string | undefined; limit?: number },
): Promise<RecipeRow[]> {
	const rows = await tables(db)
		.selectFrom('kitchen_recipes')
		.selectAll()
		.where('archived_at', 'is', null)
		.orderBy('title')
		.orderBy('id')
		.limit(1000)
		.execute();
	const q = options.q?.trim().toLocaleLowerCase();
	const tag = options.tag?.trim().toLocaleLowerCase();
	const found = rows
		.filter((r) => !q || r.title.toLocaleLowerCase().includes(q))
		.filter(
			(r) => !tag || (JSON.parse(r.tags) as string[]).some((t) => t.toLocaleLowerCase() === tag),
		)
		.toSorted((a, b) => a.title.localeCompare(b.title));
	return found.slice(0, options.limit ?? 1000);
}

export const searchRecipesRoute = defineRoute({
	method: 'get',
	path: '/recipes',
	operationId: 'kitchen.searchRecipes',
	summary: 'The recipes, by title (optionally a search and a tag)',
	requires: kitchenView.id,
	query: z.object({
		q: z.string().trim().max(100).optional(),
		tag: z.string().trim().max(40).optional(),
	}),
	response: z.array(RecipeSummarySchema),
	async handle(ctx, { query }) {
		return (await searchRecipes(ctx.db, query)).map(toRecipeSummary);
	},
});

export const getRecipe = defineRoute({
	method: 'get',
	path: '/recipes/{recipeId}',
	operationId: 'kitchen.getRecipe',
	summary: 'One recipe',
	requires: kitchenView.id,
	params: z.object({ recipeId: RecipeIdSchema }),
	response: RecipeSchema,
	async handle(ctx, { params }) {
		return toRecipe(await loadRecipe(ctx.db, params.recipeId));
	},
});

export const getRecipePhoto = defineRoute({
	method: 'get',
	path: '/recipes/{recipeId}/photo',
	operationId: 'kitchen.getRecipePhoto',
	summary: 'The photo of a recipe',
	requires: kitchenView.id,
	params: z.object({ recipeId: RecipeIdSchema }),
	response: FileResponseSchema,
	async handle(ctx, { params }) {
		const row = await loadRecipe(ctx.db, params.recipeId);
		const stored = row.photo_key ? await ctx.files.get(row.photo_key) : null;
		if (!row.photo_key || !row.photo_type || !stored)
			throw new FamosError('not_found', 'Photo not found');
		return {
			stream: stored.stream,
			contentType: row.photo_type,
			size: stored.stat.size,
			filename: 'photo',
		};
	},
});

const PHOTO_MAX_BYTES = 8 * 1024 * 1024;

export const uploadRecipePhoto = defineRoute({
	method: 'post',
	path: '/recipes/{recipeId}/photo',
	operationId: 'kitchen.uploadRecipePhoto',
	summary: 'Set the photo of a recipe (multipart: one JPEG, PNG or WebP image)',
	requires: kitchenEdit.id,
	params: z.object({ recipeId: RecipeIdSchema }),
	upload: {
		maxBytes: uploadRequestLimit(PHOTO_MAX_BYTES),
		maxFiles: 1,
		accept: ['image/jpeg', 'image/png', 'image/webp'],
	},
	response: z.object({ ok: z.literal(true) }),
	async handle(ctx, { params, files, actor }) {
		await loadRecipe(ctx.db, params.recipeId);
		const photo = await readUploadedImage(files, { maxBytes: PHOTO_MAX_BYTES });
		const key = `kitchen/recipes/${params.recipeId}/${ctx.ids.next('photo')}`;
		const { previousKey } = await storeThenRun(
			ctx.files,
			{ key, bytes: photo.bytes, type: photo.type },
			() =>
				ctx.actions.invoke<{ previousKey: string | null }>(
					'kitchen.setRecipePhoto',
					{ id: params.recipeId, key, type: photo.type },
					actor,
				),
		);
		// The new photo is saved; a leftover old file is only wasted space.
		if (previousKey) await ctx.files.delete(previousKey).catch(() => undefined);
		return { ok: true as const };
	},
});

const AI_MAX = 30;

export const aiListRecipes = defineAction({
	id: 'kitchen.listRecipes',
	title: 'Recipes, for the AI',
	input: z.object({
		query: z.string().trim().max(100).optional().describe('Part of the title to look for'),
	}),
	output: z.object({
		recipes: z.array(
			z.object({
				id: z.string(),
				title: z.string(),
				servings: z.string().nullable(),
				totalMinutes: z.number().nullable(),
				tags: z.array(z.string()),
			}),
		),
	}),
	readOnly: true,
	requires: kitchenView.id,
	ai: {
		description:
			'Lists the family recipes by title, optionally those whose title contains a word. Use it to find a recipe to plan or to answer what the family can cook.',
	},
	async run(uow, { query }) {
		const rows = await searchRecipes(uow.db, { q: query, limit: AI_MAX });
		return {
			recipes: rows.map((r) => ({
				id: r.id,
				title: r.title,
				servings: r.servings,
				totalMinutes: r.total_minutes,
				tags: JSON.parse(r.tags) as string[],
			})),
		};
	},
});
