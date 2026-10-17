import {
	type DuplicateContext,
	defineAction,
	defineRoute,
	FamosError,
	storedAsWhole,
	type UnitOfWork,
} from '@famos/sdk';
import { addDays, dateLocale, formatDate, IsoDateSchema, todayIn } from '@famos/time';
import { z } from 'zod';
import {
	AddToMealPlanSchema,
	MEAL_SLOTS,
	MealEntryFieldsSchema,
	MealEntrySchema,
	MealIdSchema,
	ReviewLabelSchema,
	UpdateMealEntrySchema,
} from '../contract/index.ts';
import { kitchenChanged, kitchenEdit, kitchenView } from './capabilities.ts';
import { loadRecipe, memberId } from './recipes.ts';
import { type MealRow, tables, toMeal } from './store.ts';

const MAX_RANGE_DAYS = 62;
const slotOrder = (slot: string) => MEAL_SLOTS.indexOf(slot as (typeof MEAL_SLOTS)[number]);

/** Entries from `from` to `to` (inclusive) in date, slot and entry order. */
async function mealsBetween(db: UnitOfWork['db'], from: string, to: string) {
	const rows = await tables(db)
		.selectFrom('kitchen_meal_plan as m')
		.leftJoin('kitchen_recipes as r', 'r.id', 'm.recipe_id')
		.selectAll('m')
		.select('r.title as recipe_title')
		.where('m.date', '>=', from)
		.where('m.date', '<=', to)
		.orderBy('m.date')
		.orderBy('m.created_at')
		.orderBy('m.id')
		.execute();
	return rows
		.map(({ recipe_title, ...row }) => toMeal(row as MealRow, recipe_title))
		.toSorted((a, b) => a.date.localeCompare(b.date) || slotOrder(a.slot) - slotOrder(b.slot));
}

async function recipeIdOrNull(uow: UnitOfWork, recipeId: string | null | undefined) {
	if (!recipeId) return null;
	await loadRecipe(uow.db, recipeId);
	return recipeId;
}

const mealOut = async (uow: UnitOfWork, row: MealRow) => {
	const recipe = row.recipe_id
		? await tables(uow.db)
				.selectFrom('kitchen_recipes')
				.select('title')
				.where('id', '=', row.recipe_id)
				.executeTakeFirst()
		: undefined;
	return toMeal(row, recipe?.title ?? null);
};

export const addToMealPlan = defineAction({
	id: 'kitchen.addToMealPlan',
	title: 'Plan a meal',
	draftTitle: 'kitchen:draft_title_add_to_meal_plan',
	input: AddToMealPlanSchema,
	output: MealEntrySchema,
	approval: { unless: kitchenEdit.id },
	undo: (entry) => ({ actionId: 'kitchen.removeMealPlanEntry', input: { id: entry.id } }),
	// A meal for a day that has passed is no longer worth planning.
	draftDate: (input) => input.date,
	ai: {
		description:
			'Put a meal on the family meal plan for a day: breakfast, lunch, dinner or something else, either a saved recipe or a written dish.',
		guidance:
			'date is the day it is cooked (YYYY-MM-DD). slot is breakfast, lunch, dinner or other (dinner when not said). Use recipeId only with a recipe’s reference from the recipe list; otherwise write the dish in title, in the family language.',
	},
	async alreadyThere(ctx, input) {
		const rows = await tables(ctx.db)
			.selectFrom('kitchen_meal_plan')
			.select(['recipe_id', 'title'])
			.where('date', '=', input.date)
			.where('slot', '=', input.slot)
			.execute();
		return rows.some((r) =>
			input.recipeId
				? r.recipe_id === input.recipeId
				: r.recipe_id === null && r.title === input.title,
		);
	},
	async run(uow, input) {
		const recipeId = await recipeIdOrNull(uow, input.recipeId);
		const now = uow.clock.now();
		const row: MealRow = {
			id: uow.ids.next('meal'),
			date: input.date,
			slot: input.slot,
			recipe_id: recipeId,
			title: input.title,
			note: input.note || null,
			created_by: memberId(uow.actor),
			created_at: now,
			updated_at: now,
		};
		await tables(uow.db).insertInto('kitchen_meal_plan').values(row).execute();
		uow.emit(kitchenChanged, { area: 'meals' });
		return mealOut(uow, row);
	},
});

export const updateMealPlanEntry = defineAction({
	id: 'kitchen.updateMealPlanEntry',
	title: 'Change a planned meal',
	draftTitle: 'kitchen:draft_title_update_meal_plan_entry',
	input: UpdateMealEntrySchema,
	// Waiting from when a field left out meant empty (or its default): read that way.
	storedInput: storedAsWhole(MealEntryFieldsSchema, 'entry'),
	output: MealEntrySchema,
	approval: { unless: kitchenEdit.id },
	async run(uow, { id, entry }) {
		const row = await tables(uow.db)
			.selectFrom('kitchen_meal_plan')
			.selectAll()
			.where('id', '=', id)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', 'Meal not found');
		const patch = {
			date: entry.date,
			slot: entry.slot,
			recipe_id: await recipeIdOrNull(uow, entry.recipeId),
			title: entry.title,
			note: entry.note || null,
			updated_at: uow.clock.now(),
		};
		await tables(uow.db).updateTable('kitchen_meal_plan').set(patch).where('id', '=', id).execute();
		uow.emit(kitchenChanged, { area: 'meals' });
		return mealOut(uow, { ...row, ...patch });
	},
});

/** The planned meal and its day, for the runner's check that an AI's label names the right one. */
const mealTitle = async (ctx: DuplicateContext, { id }: { id: string }) => {
	const row = await tables(ctx.db)
		.selectFrom('kitchen_meal_plan as m')
		.leftJoin('kitchen_recipes as r', 'r.id', 'm.recipe_id')
		.select(['m.title', 'm.date', 'm.slot', 'r.title as recipe_title'])
		.where('m.id', '=', id)
		.executeTakeFirst();
	if (!row) return null;
	// People read this on cards and in notices: the dish first (it is what a label is matched
	// against), then the meal and the day in the family's own formats.
	const { locale, formatLocale, hourCycle } = await ctx.family.settings();
	const slot = ctx.translate(locale, `kitchen:slot_${row.slot}`).toLocaleLowerCase(locale);
	const day = formatDate(row.date, dateLocale(locale, formatLocale, hourCycle), {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
	});
	return `${row.recipe_title ?? row.title} · ${slot}, ${day}`;
};

export const removeMealPlanEntry = defineAction({
	id: 'kitchen.removeMealPlanEntry',
	title: 'Take a meal off the plan',
	draftTitle: 'kitchen:draft_title_remove_meal_plan_entry',
	targetTitle: mealTitle,
	input: z.object({ id: MealIdSchema, label: ReviewLabelSchema }),
	output: z.object({
		ok: z.literal(true),
		/** What was taken off, so the removal can be undone; absent when it was already gone. */
		removed: z
			.object({
				date: z.string(),
				slot: z.enum(MEAL_SLOTS),
				recipeId: z.string().nullable(),
				title: z.string(),
				note: z.string().nullable(),
			})
			.optional(),
	}),
	approval: { unless: kitchenEdit.id },
	undo: ({ removed }) => (removed ? { actionId: 'kitchen.addToMealPlan', input: removed } : null),
	ai: {
		description:
			'Takes a planned meal off the family meal plan. Find it with kitchen.mealPlan first.',
	},
	async run(uow, { id }) {
		// Already gone (undoing twice, a second tap) is fine.
		const row = await tables(uow.db)
			.selectFrom('kitchen_meal_plan')
			.selectAll()
			.where('id', '=', id)
			.executeTakeFirst();
		if (!row) return { ok: true as const };
		await tables(uow.db).deleteFrom('kitchen_meal_plan').where('id', '=', id).execute();
		uow.emit(kitchenChanged, { area: 'meals' });
		return {
			ok: true as const,
			removed: {
				date: row.date,
				slot: row.slot,
				recipeId: row.recipe_id,
				title: row.title,
				note: row.note,
			},
		};
	},
});

export const getMealPlan = defineRoute({
	method: 'get',
	path: '/meal-plan',
	operationId: 'kitchen.getMealPlan',
	summary: 'Planned meals from one day to another (at most two months)',
	requires: kitchenView.id,
	query: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
	response: z.array(MealEntrySchema),
	async handle(ctx, { query }) {
		if (query.to < query.from || query.to > addDays(query.from, MAX_RANGE_DAYS))
			throw new FamosError('bad_request', 'Ask for at most two months');
		return mealsBetween(ctx.db, query.from, query.to);
	},
});

export const aiMealPlan = defineAction({
	id: 'kitchen.mealPlan',
	title: 'Meal plan, for the AI',
	input: z.object({
		from: IsoDateSchema.optional().describe('First day, YYYY-MM-DD; today when omitted'),
		days: z.number().int().min(1).max(31).default(7).describe('How many days to look at'),
	}),
	output: z.object({
		meals: z.array(
			z.object({
				id: z.string(),
				date: z.string(),
				slot: z.string(),
				title: z.string(),
				recipeId: z.string().nullable(),
			}),
		),
	}),
	readOnly: true,
	requires: kitchenView.id,
	ai: {
		description:
			'The meal plan: what is planned to be cooked on which day (breakfast, lunch, dinner). Use it for "what is for dinner" questions.',
	},
	async run(uow, { from, days }) {
		const { timeZone } = await uow.family.settings();
		const start = from ?? todayIn(timeZone, uow.clock.now());
		const meals = await mealsBetween(uow.db, start, addDays(start, days - 1));
		return {
			meals: meals.map((m) => ({
				id: m.id,
				date: m.date,
				slot: m.slot,
				title: m.title,
				recipeId: m.recipeId,
			})),
		};
	},
});
