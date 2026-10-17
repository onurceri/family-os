import { FamosError, type UploadedFile } from '@famos/sdk';
import type { TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MealEntry, Recipe, RecipeSummary } from '../src/contract/index.ts';
import { AI, applied, createKernel, type Person, person } from './support.ts';

let k: TestKernel;
let admin: Person;

beforeEach(async () => {
	k = await createKernel();
	admin = await person(k, 'admin', 'Ayşe');
});
afterEach(() => k.close());

const soup = {
	title: 'Lentil soup',
	servings: '4',
	totalMinutes: 40,
	ingredients: ['1 cup red lentils', '1 onion', '2 carrots'],
	steps: ['Chop.', 'Simmer.'],
	tags: ['soup'],
};
const addRecipe = (input: Record<string, unknown> = {}, actor = admin.actor) =>
	applied<Recipe>(k, 'kitchen.createRecipe', { ...soup, ...input }, actor);
const recipes = (
	query: Record<string, unknown> = {},
	actor = admin.actor,
): Promise<RecipeSummary[]> => k.route('kitchen.searchRecipes').call({ query, actor });
const meals = (from = '2026-10-05', to = '2026-10-11'): Promise<MealEntry[]> =>
	k.route('kitchen.getMealPlan').call({ query: { from, to } });

describe('migrations', () => {
	it('creates the tables on an empty database', async () => {
		expect(await recipes()).toEqual([]);
		expect(await meals()).toEqual([]);
	});
});

describe('recipes', () => {
	it('adds, reads, lists and changes a recipe', async () => {
		const created = await addRecipe({
			sourceUrl: 'https://example.com/lentil?utm=1',
			notes: 'Less salt',
		});
		expect(created).toMatchObject({
			title: 'Lentil soup',
			servings: '4',
			totalMinutes: 40,
			hasPhoto: false,
			sourceUrl: 'https://example.com/lentil?utm=1',
			createdBy: admin.id,
		});
		expect(created.id).toMatch(/^recipe_/);
		expect(
			await k.route('kitchen.getRecipe').call({ params: { recipeId: created.id } }),
		).toMatchObject({
			ingredients: soup.ingredients,
			steps: soup.steps,
			notes: 'Less salt',
		});
		expect(await recipes()).toMatchObject([
			{ id: created.id, title: 'Lentil soup', tags: ['soup'] },
		]);

		const changed = await applied<Recipe>(
			k,
			'kitchen.updateRecipe',
			{
				id: created.id,
				recipe: {
					title: 'Red lentil soup',
					servings: null,
					totalMinutes: null,
					ingredients: ['lentils'],
					steps: [],
					notes: 'Less salt',
					sourceUrl: null,
					tags: ['soup'],
				},
			},
			admin.actor,
		);
		expect(changed).toMatchObject({
			title: 'Red lentil soup',
			ingredients: ['lentils'],
			servings: null,
			steps: [],
			notes: 'Less salt',
		});
		// The form always sends the whole recipe: one that leaves fields out is refused, not cleared.
		await expect(
			k.runner.invoke(
				'kitchen.updateRecipe',
				{ id: created.id, recipe: { title: 'Soup' } },
				admin.actor,
			),
		).rejects.toMatchObject({ code: 'bad_request' });
		expect(await recipes()).toMatchObject([{ title: 'Red lentil soup', tags: ['soup'] }]);
	});

	it('searches by title and tag, in the order of the titles', async () => {
		await addRecipe({ title: 'Zucchini pie', tags: ['baking'] });
		await addRecipe({ title: 'Apple pie', tags: ['Baking', 'sweet'] });
		await addRecipe({ title: 'Lentil soup' });
		expect((await recipes()).map((r) => r.title)).toEqual([
			'Apple pie',
			'Lentil soup',
			'Zucchini pie',
		]);
		expect((await recipes({ q: 'PIE' })).map((r) => r.title)).toEqual([
			'Apple pie',
			'Zucchini pie',
		]);
		expect((await recipes({ tag: 'baking' })).map((r) => r.title)).toEqual([
			'Apple pie',
			'Zucchini pie',
		]);
		expect((await recipes({ q: 'apple', tag: 'sweet' })).map((r) => r.title)).toEqual([
			'Apple pie',
		]);
		expect(await recipes({ q: 'pizza' })).toEqual([]);
	});

	it('refuses a missing title, a bad address and too many lines', async () => {
		const fail = (input: Record<string, unknown>) =>
			addRecipe(input).then(
				() => null,
				(e: unknown) => e,
			);
		expect(await fail({ title: '  ' })).toBeInstanceOf(FamosError);
		expect(await fail({ sourceUrl: 'javascript:alert(1)' })).toBeInstanceOf(FamosError);
		expect(await fail({ sourceUrl: 'https://user:pw@example.com/' })).toBeInstanceOf(FamosError);
		expect(await fail({ ingredients: Array.from({ length: 101 }, () => 'x') })).toBeInstanceOf(
			FamosError,
		);
		expect(await recipes()).toHaveLength(0);
	});

	it('archives a recipe and hides it; archiving again is harmless', async () => {
		const r = await addRecipe();
		await applied(k, 'kitchen.archiveRecipe', { id: r.id }, admin.actor);
		await applied(k, 'kitchen.archiveRecipe', { id: r.id }, admin.actor);
		expect(await recipes()).toEqual([]);
		await expect(
			k.route('kitchen.getRecipe').call({ params: { recipeId: r.id } }),
		).rejects.toMatchObject({
			code: 'not_found',
		});
		await expect(
			applied(
				k,
				'kitchen.archiveRecipe',
				{ id: 'recipe_00000000-0000-7000-8000-000000000001' },
				admin.actor,
			),
		).rejects.toMatchObject({ code: 'not_found' });
	});
});

describe('recipe photo', () => {
	const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
	const file = (bytes: Uint8Array, type = 'image/jpeg'): UploadedFile => ({
		field: 'file',
		name: 'p.jpg',
		type,
		size: bytes.length,
		stream: async function* () {
			yield bytes;
		},
		bytes: async () => bytes,
	});
	const upload = (recipeId: string, f: UploadedFile, actor = admin.actor) =>
		k.route('kitchen.uploadRecipePhoto').call({ params: { recipeId }, files: [f], actor });
	const read = async (recipeId: string) => {
		const res = await k.route('kitchen.getRecipePhoto').call({ params: { recipeId } });
		const chunks: Uint8Array[] = [];
		for await (const chunk of res.stream) chunks.push(chunk);
		return { type: res.contentType as string, bytes: Buffer.concat(chunks) };
	};

	it('stores an image, serves it with the sniffed type and replaces it', async () => {
		const r = await addRecipe();
		await upload(r.id, file(jpeg));
		expect((await recipes())[0]?.hasPhoto).toBe(true);
		expect(await read(r.id)).toMatchObject({ type: 'image/jpeg' });
		const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
		await upload(r.id, file(png, 'image/jpeg'));
		expect(await read(r.id)).toMatchObject({ type: 'image/png' });
	});

	it('refuses something that is not an image, even when it says so', async () => {
		const r = await addRecipe();
		const html = new TextEncoder().encode('<html><script>alert(1)</script>');
		await expect(upload(r.id, file(html, 'image/jpeg'))).rejects.toMatchObject({
			code: 'bad_request',
		});
		expect((await recipes())[0]?.hasPhoto).toBe(false);
		await expect(
			k.route('kitchen.getRecipePhoto').call({ params: { recipeId: r.id } }),
		).rejects.toMatchObject({
			code: 'not_found',
		});
	});

	it('refuses an upload for an unknown recipe and from a member who may not edit', async () => {
		await expect(
			upload('recipe_00000000-0000-7000-8000-000000000001', file(jpeg)),
		).rejects.toMatchObject({ code: 'not_found' });
		const r = await addRecipe();
		const kid = await person(k, 'supervised', 'Elif');
		await expect(upload(r.id, file(jpeg), kid.actor)).rejects.toMatchObject({ code: 'forbidden' });
	});
});

describe('meal plan', () => {
	it('plans a recipe and a written dish, several per slot, in day and slot order', async () => {
		const r = await addRecipe();
		const add = (input: Record<string, unknown>) =>
			applied<MealEntry>(k, 'kitchen.addToMealPlan', input, admin.actor);
		await add({ date: '2026-10-07', slot: 'dinner', recipeId: r.id });
		await add({ date: '2026-10-07', slot: 'breakfast', title: 'Eggs' });
		await add({ date: '2026-10-07', slot: 'dinner', title: 'Salad', note: 'Side dish' });
		await add({ date: '2026-10-06', title: 'Leftovers' });
		const list = await meals();
		expect(list.map((m) => [m.date, m.slot, m.title])).toEqual([
			['2026-10-06', 'dinner', 'Leftovers'],
			['2026-10-07', 'breakfast', 'Eggs'],
			['2026-10-07', 'dinner', 'Lentil soup'],
			['2026-10-07', 'dinner', 'Salad'],
		]);
		expect(list[2]?.recipeId).toBe(r.id);
		expect(list[3]?.note).toBe('Side dish');
		// A week outside the range is empty.
		expect(await meals('2026-10-12', '2026-10-18')).toEqual([]);
	});

	it('changes and removes an entry, and removing twice is harmless', async () => {
		const m = await applied<MealEntry>(
			k,
			'kitchen.addToMealPlan',
			{ date: '2026-10-07', title: 'Pasta' },
			admin.actor,
		);
		const changed = await applied<MealEntry>(
			k,
			'kitchen.updateMealPlanEntry',
			{
				id: m.id,
				entry: {
					date: '2026-10-08',
					slot: 'lunch',
					recipeId: null,
					title: 'Pasta bake',
					note: null,
				},
			},
			admin.actor,
		);
		expect(changed).toMatchObject({ date: '2026-10-08', slot: 'lunch', title: 'Pasta bake' });
		await expect(
			k.runner.invoke(
				'kitchen.updateMealPlanEntry',
				{ id: m.id, entry: { date: '2026-10-09', title: 'Pasta bake' } },
				admin.actor,
			),
		).rejects.toMatchObject({ code: 'bad_request' });
		await applied(k, 'kitchen.removeMealPlanEntry', { id: m.id }, admin.actor);
		await applied(k, 'kitchen.removeMealPlanEntry', { id: m.id }, admin.actor);
		expect(await meals()).toEqual([]);
		await expect(
			applied(
				k,
				'kitchen.updateMealPlanEntry',
				{
					id: m.id,
					entry: { date: '2026-10-08', slot: 'dinner', recipeId: null, title: 'x', note: null },
				},
				admin.actor,
			),
		).rejects.toMatchObject({ code: 'not_found' });
	});

	it('needs a recipe or a title, a real recipe and a valid date', async () => {
		const add = (input: Record<string, unknown>) =>
			applied(k, 'kitchen.addToMealPlan', input, admin.actor);
		await expect(add({ date: '2026-10-07' })).rejects.toBeInstanceOf(FamosError);
		await expect(add({ date: '2026-13-07', title: 'x' })).rejects.toBeInstanceOf(FamosError);
		await expect(
			add({ date: '2026-10-07', recipeId: 'recipe_00000000-0000-7000-8000-000000000001' }),
		).rejects.toMatchObject({ code: 'not_found' });
		expect(await meals()).toEqual([]);
	});

	it('keeps an entry readable after its recipe is archived', async () => {
		const r = await addRecipe();
		await applied(k, 'kitchen.addToMealPlan', { date: '2026-10-07', recipeId: r.id }, admin.actor);
		await applied(k, 'kitchen.archiveRecipe', { id: r.id }, admin.actor);
		expect((await meals()).map((m) => m.title)).toEqual(['Lentil soup']);
	});

	it('limits the range of the route', async () => {
		await expect(meals('2026-10-05', '2027-01-01')).rejects.toMatchObject({ code: 'bad_request' });
		await expect(meals('2026-10-05', '2026-10-01')).rejects.toMatchObject({ code: 'bad_request' });
	});
});

describe('capabilities', () => {
	it('lets an admin change things directly and a supervised member only look and propose', async () => {
		const kid = await person(k, 'supervised', 'Elif');
		const r = await addRecipe();
		// They may look.
		expect(await recipes({}, kid.actor)).toHaveLength(1);
		// Their changes wait for approval.
		for (const [action, input] of [
			['kitchen.createRecipe', soup],
			['kitchen.addToMealPlan', { date: '2026-10-07', title: 'Pasta' }],
			['kitchen.archiveRecipe', { id: r.id }],
		] as const) {
			expect((await k.runner.invoke(action, input, kid.actor)).status).toBe('drafted');
		}
		expect(await recipes()).toHaveLength(1);
		expect(await meals()).toEqual([]);
		// An admin approves one.
		const drafts = await k
			.route('core.listDrafts')
			.call({ query: { status: 'pending', limit: 10 } });
		const mealDraft = drafts.find(
			(d: { actionId: string }) => d.actionId === 'kitchen.addToMealPlan',
		);
		await k.runner.approveDraft(mealDraft.id, admin.actor);
		expect((await meals()).map((m) => m.title)).toEqual(['Pasta']);
	});

	it('keeps the photo upload and the internal actions for people who edit', async () => {
		const kid = await person(k, 'supervised', 'Elif');
		const r = await addRecipe();
		await expect(
			k.runner.invoke(
				'kitchen.setRecipePhoto',
				{ id: r.id, key: `kitchen/recipes/${r.id}/photo_1`, type: 'image/png' },
				kid.actor,
			),
		).rejects.toMatchObject({ code: 'forbidden' });
	});

	it('only takes photo keys the upload route makes for that recipe', async () => {
		const r = await addRecipe();
		const other = await addRecipe();
		for (const key of ['inbox/item_1/0', `kitchen/recipes/${other.id}/photo_1`, '../secret']) {
			await expect(
				k.runner.invoke(
					'kitchen.setRecipePhoto',
					{ id: r.id, key, type: 'image/png' },
					admin.actor,
				),
				key,
			).rejects.toBeTruthy();
		}
	});

	it('lets a guest look but not propose or change anything', async () => {
		const guest = await person(k, 'guest', 'Visitor');
		await addRecipe();
		expect(await recipes({}, guest.actor)).toHaveLength(1);
		await expect(k.runner.invoke('kitchen.createRecipe', soup, guest.actor)).rejects.toMatchObject({
			code: 'forbidden',
		});
	});

	it('shows every route only to people who may view the kitchen', async () => {
		const routes = k.registry.routes.filter((r) => r.route.operationId.startsWith('kitchen.'));
		expect(routes.length).toBeGreaterThan(3);
		for (const { route } of routes) {
			expect(route.requires, route.operationId).toMatch(/^kitchen\.(view|edit)$/);
		}
	});
});

describe('AI', () => {
	it('offers recipes and meals as drafts, and only reads for the rest', () => {
		const catalog = k.ctx.actions.aiCatalog().map((a) => a.id);
		expect(catalog).toEqual(
			expect.arrayContaining([
				'kitchen.createRecipe',
				'kitchen.addToMealPlan',
				'kitchen.removeMealPlanEntry',
			]),
		);
		for (const id of [
			'kitchen.updateRecipe',
			'kitchen.archiveRecipe',
			'kitchen.addIngredientsToShopping',
			'kitchen.setRecipePhoto',
			'kitchen.updateMealPlanEntry',
		]) {
			expect(catalog, id).not.toContain(id);
		}
		const reads = k.ctx.actions.aiReadTools({ local: true }).map((a) => a.id);
		expect(reads).toEqual(expect.arrayContaining(['kitchen.listRecipes', 'kitchen.mealPlan']));
		for (const id of ['kitchen.listRecipes', 'kitchen.mealPlan']) {
			expect(k.registry.actions.get(id)?.readOnly, id).toBe(true);
		}
	});

	it('proposes a recipe as a draft that an admin approves, and undo archives it', async () => {
		const result = await k.runner.invoke('kitchen.createRecipe', soup, AI, {
			draft: { sourceKind: 'inbox', sourceId: 'item', summary: 'Lentil soup' },
		});
		expect(result.status).toBe('drafted');
		expect(await recipes()).toEqual([]);
		if (result.status !== 'drafted') return;
		await k.runner.approveDraft(result.draftId, admin.actor);
		expect(await recipes()).toHaveLength(1);
		await k.runner.undoDraft(result.draftId, admin.actor);
		expect(await recipes()).toEqual([]);
	});

	it('proposes a meal with undo', async () => {
		const meal = await k.runner.invoke(
			'kitchen.addToMealPlan',
			{ date: '2026-10-07', title: 'Pasta' },
			AI,
		);
		if (meal.status !== 'drafted') throw new Error('expected a draft');
		await k.runner.approveDraft(meal.draftId, admin.actor);
		expect(await meals()).toHaveLength(1);
		await k.runner.undoDraft(meal.draftId, admin.actor);
		expect(await meals()).toEqual([]);
	});

	it('flags a draft for something that seems to be there already', async () => {
		await addRecipe();
		await applied(k, 'kitchen.addToMealPlan', { date: '2026-10-07', title: 'Pasta' }, admin.actor);
		await k.runner.invoke('kitchen.createRecipe', soup, AI);
		await k.runner.invoke('kitchen.addToMealPlan', { date: '2026-10-07', title: 'Pasta' }, AI);
		await k.runner.invoke('kitchen.addToMealPlan', { date: '2026-10-08', title: 'Pasta' }, AI);
		const drafts = await k
			.route('core.listDrafts')
			.call({ query: { status: 'pending', limit: 10 } });
		expect(drafts.map((d: { mayExist: boolean }) => d.mayExist)).toEqual(
			expect.arrayContaining([true, true, false]),
		);
		expect(drafts.filter((d: { mayExist: boolean }) => d.mayExist)).toHaveLength(2);
	});

	it('answers the read tools with ids the host turns into handles', async () => {
		const r = await addRecipe();
		await applied(k, 'kitchen.addToMealPlan', { date: '2026-10-06', recipeId: r.id }, admin.actor);
		expect(await applied(k, 'kitchen.listRecipes', { query: 'lentil' }, AI)).toMatchObject({
			recipes: [{ id: r.id, title: 'Lentil soup' }],
		});
		expect(await applied(k, 'kitchen.listRecipes', { query: 'pizza' }, AI)).toEqual({
			recipes: [],
		});
		expect(await applied(k, 'kitchen.mealPlan', {}, AI)).toMatchObject({
			meals: [{ date: '2026-10-06', slot: 'dinner', title: 'Lentil soup', recipeId: r.id }],
		});
	});

	it('closes the read tools when the area is off for the AI, but not for people', async () => {
		await addRecipe();
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'kitchen', access: 'off' },
			admin.actor,
		);
		await expect(k.runner.invoke('kitchen.listRecipes', {}, AI)).rejects.toMatchObject({
			code: 'forbidden',
		});
		await expect(k.runner.invoke('kitchen.createRecipe', soup, AI)).rejects.toMatchObject({
			code: 'forbidden',
		});
		expect(await recipes()).toHaveLength(1);
	});

	it('words the Inbox guidance for recipes', () => {
		const hints = k.registry.actions.get('kitchen.createRecipe')?.ai;
		expect(hints?.description).toMatch(/recipe/i);
		expect(hints?.guidance).toMatch(/original language/i);
		expect(hints?.guidance).toMatch(/one ingredient per entry/i);
	});
});
