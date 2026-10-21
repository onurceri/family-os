import {
	defineMentionKind,
	type IndexedMention,
	type MentionContext,
	type Resolution,
	whichOne,
} from '@famos/sdk';
import { addDays } from '@famos/time';
import { isHttpUrl, MEAL_SLOTS, type MealSlot } from '../contract/index.ts';
import { tables } from './store.ts';

const MAX_MINUTES = 10_080;
const SERVINGS_MAX = 30;
const TAG_MAX = 40;
/** How far ahead a planned meal can be taken off by its name. */
const PLAN_DAYS = 31;

const same = (a: string, b: string) =>
	a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** A line that starts with its number ("1. Heat the oven", "2) Stir"): a step, not an ingredient. */
const NUMBERED = /^\s*\d{1,3}[.)]\s+/u;

/** The ingredients, then the steps from the first numbered line on, numbers taken off. */
export function recipeLines(lines: readonly string[]): { ingredients: string[]; steps: string[] } {
	const first = lines.findIndex((line) => NUMBERED.test(line));
	const cut = first < 0 ? lines.length : first;
	return {
		ingredients: lines
			.slice(0, cut)
			.map((l) => l.trim())
			.filter(Boolean),
		steps: lines
			.slice(cut)
			.map((l) => l.replace(NUMBERED, '').trim())
			.filter(Boolean),
	};
}

/** The one web address the shared text holds, if it holds exactly one. */
export function sourceUrlOf(text: string | null): string | null {
	const found = new Set(
		[...(text ?? '').matchAll(/https?:\/\/[^\s<>"']+/giu)].map((m) =>
			m[0].replace(/[.,;:!?)\]]+$/u, ''),
		),
	);
	const [only] = found;
	return found.size === 1 && only && isHttpUrl(only) ? only : null;
}

async function resolveRecipe(ctx: MentionContext, { index, mention }: IndexedMention) {
	const title = mention.title;
	if (!title) return refuse('incomplete', null, index);
	const { ingredients, steps } = recipeLines(mention.lines ?? []);
	if (ingredients.length === 0 && steps.length === 0) return refuse('incomplete', title, index);
	const recipes = await tables(ctx.db)
		.selectFrom('kitchen_recipes')
		.select('title')
		.where('archived_at', 'is', null)
		.execute();
	if (recipes.some((r) => same(r.title, title))) return refuse('already', title, index);
	const minutes = /^\s*(\d{1,5})\s*$/u.exec(mention.amount ?? '');
	const totalMinutes = minutes ? Number(minutes[1]) : 0;
	const servings = mention.quantity?.trim().slice(0, SERVINGS_MAX);
	const tags = [...new Set((mention.tags ?? []).map((t) => t.trim().slice(0, TAG_MAX)))].filter(
		Boolean,
	);
	const sourceUrl = sourceUrlOf(ctx.text);
	return {
		propose: {
			actionId: 'kitchen.createRecipe',
			input: {
				title,
				ingredients,
				steps,
				...(servings && { servings }),
				...(totalMinutes >= 1 && totalMinutes <= MAX_MINUTES && { totalMinutes }),
				...(tags.length > 0 && { tags: tags.slice(0, 20) }),
				...(mention.notes && { notes: mention.notes }),
				...(sourceUrl && { sourceUrl }),
			},
			subject: title,
			from: [index],
		},
	} satisfies Resolution;
}

const isSlot = (value: string | undefined): value is MealSlot =>
	(MEAL_SLOTS as readonly string[]).includes(value ?? '');

async function resolveMeal(ctx: MentionContext, { index, mention }: IndexedMention) {
	const dish = mention.title;
	if (!dish) return refuse('incomplete', null, index);
	// A meal is for a day: when the model gave none but the words it copied name one ("fish pie
	// for dinner on Friday"), that is the day, for a person to check.
	const fromQuote = mention.date === undefined && mention.quote !== undefined;
	const day = ctx.day(fromQuote ? { text: mention.quote as string } : mention.date, 'future');
	if (!day) return refuse('incomplete', dish, index);
	const slot: MealSlot = isSlot(mention.variant) ? mention.variant : 'dinner';
	const recipes = await tables(ctx.db)
		.selectFrom('kitchen_recipes')
		.select(['id', 'title as label'])
		.where('archived_at', 'is', null)
		.execute();
	const recipe = ctx.target(dish, recipes);
	const recipeId = 'found' in recipe ? recipe.found.id : null;
	const planned = await tables(ctx.db)
		.selectFrom('kitchen_meal_plan')
		.select(['recipe_id', 'title'])
		.where('date', '=', day.date)
		.where('slot', '=', slot)
		.execute();
	if (planned.some((p) => (recipeId ? p.recipe_id === recipeId : same(p.title, dish))))
		return refuse('already', dish, index);
	return {
		propose: {
			actionId: 'kitchen.addToMealPlan',
			input: {
				date: day.date,
				slot,
				...(recipeId ? { recipeId, title: '' } : { title: dish }),
				...(mention.notes && { note: mention.notes }),
			},
			subject: dish,
			uncertain: day.certain && !fromQuote ? [] : ['date'],
			// No meal named: dinner, which a person is asked to confirm.
			...(!isSlot(mention.variant) && { decided: { slot: 'defaulted' as const } }),
			from: [index],
		},
	} satisfies Resolution;
}

async function resolveMealOff(ctx: MentionContext, { index, mention }: IndexedMention) {
	const words = mention.target ?? mention.title;
	if (!words) return refuse('incomplete', null, index);
	const day = ctx.day(mention.date, 'future');
	let query = tables(ctx.db)
		.selectFrom('kitchen_meal_plan as m')
		.leftJoin('kitchen_recipes as r', 'r.id', 'm.recipe_id')
		.select(['m.id as id', 'm.title as title', 'r.title as recipe_title'])
		.where('m.date', '>=', ctx.today)
		.where('m.date', '<=', addDays(ctx.today, PLAN_DAYS));
	if (day) query = query.where('m.date', '=', day.date);
	if (isSlot(mention.variant)) query = query.where('m.slot', '=', mention.variant);
	const meals = (await query.orderBy('m.date').execute()).map((m) => ({
		id: m.id,
		label: m.recipe_title ?? m.title,
	}));
	const found = ctx.target(words, meals);
	if ('none' in found) return refuse('unknown', words, index);
	if ('ambiguous' in found) return refuse('ambiguous', whichOne(words, found.ambiguous), index);
	return {
		propose: {
			actionId: 'kitchen.removeMealPlanEntry',
			input: { id: found.found.id, label: words },
			subject: words,
			targetTitle: found.found.label,
			removes: true,
			from: [index],
		},
	} satisfies Resolution;
}

function refuse(
	reason: 'already' | 'unknown' | 'ambiguous' | 'incomplete',
	subject: string | null,
	index: number,
): Resolution {
	return { refuse: { reason, subject, from: [index] } };
}

const each =
	(one: (ctx: MentionContext, m: IndexedMention) => Promise<Resolution>) =>
	async (ctx: MentionContext, mentions: readonly IndexedMention[]) => {
		const out: Resolution[] = [];
		for (const m of mentions) out.push(await one(ctx, m));
		return out;
	};

export const recipeKind = defineMentionKind({
	id: 'kitchen.recipe',
	describe:
		'A recipe the family shared to keep (a photo of a recipe, a page, a message with a recipe): its name, ingredients and steps. Only when the message holds the recipe itself, not when it only names a dish.',
	slots: {
		title: 'The name of the dish, as written',
		lines:
			'The ingredients, one per entry exactly as written with the amount ("2 cups flour"), then the steps in order, each starting with its number and a full stop ("1. Heat the oven")',
		quantity: 'How many it serves, as written ("4")',
		amount: 'The total time in minutes, digits only ("45"), when stated',
		tags: 'Short labels the message gives ("soup", "quick")',
		notes: 'A short note that is not an ingredient or a step',
	},
	actions: ['kitchen.createRecipe'],
	limit: 4,
	examples: [
		{
			text: 'Lentil soup (serves 4, 40 min): 1 cup red lentils, 1 onion, 1 litre water. Fry the onion, add the lentils and water, simmer for 30 minutes.',
			mentions: [
				{
					kind: 'kitchen.recipe',
					quote: 'Lentil soup (serves 4, 40 min)',
					title: 'Lentil soup',
					lines: [
						'1 cup red lentils',
						'1 onion',
						'1 litre water',
						'1. Fry the onion.',
						'2. Add the lentils and water.',
						'3. Simmer for 30 minutes.',
					],
					quantity: '4',
					amount: '40',
				},
			],
		},
		{
			text: 'We should make that lentil soup again soon',
			mentions: [],
			why: 'naming a dish is not sharing a recipe',
		},
	],
	decides: {},
	resolve: each(resolveRecipe),
});

export const mealKind = defineMentionKind({
	id: 'kitchen.meal',
	describe:
		'A meal planned for a day on the family meal plan: what is cooked, and for which meal. Not for eating out or a restaurant booking (that is an event).',
	slots: {
		title: 'What is cooked, in the family language ("Pancakes")',
		date: 'The day it is cooked',
		variant: 'Which meal; dinner when the message does not say',
		notes: 'A short note ("Leo is cooking")',
	},
	variants: MEAL_SLOTS,
	actions: ['kitchen.addToMealPlan'],
	limit: 14,
	examples: [
		{
			text: 'Pancakes for breakfast on Sunday, lentil soup for dinner on Monday',
			mentions: [
				{
					kind: 'kitchen.meal',
					quote: 'Pancakes for breakfast on Sunday',
					title: 'Pancakes',
					variant: 'breakfast',
					date: { text: 'Sunday', weekday: 7 },
				},
				{
					kind: 'kitchen.meal',
					quote: 'lentil soup for dinner on Monday',
					title: 'Lentil soup',
					variant: 'dinner',
					date: { text: 'Monday', weekday: 1 },
				},
			],
		},
		{
			text: "Let's do pizza tonight",
			mentions: [
				{
					kind: 'kitchen.meal',
					quote: "Let's do pizza tonight",
					title: 'Pizza',
					variant: 'dinner',
					date: { text: 'tonight', inDays: 0 },
				},
			],
		},
	],
	decides: { slot: 'defaulted' },
	resolve: each(resolveMeal),
});

export const mealOffKind = defineMentionKind({
	id: 'kitchen.mealOff',
	describe:
		'A planned meal that is no longer cooked: the plan changed, the dish is off. Only for a meal the plan already has; a new dish instead is also a kitchen.meal.',
	slots: {
		target: 'The planned dish, by its name',
		date: 'The day it was planned for, when the message says',
		variant: 'Which meal, when the message says',
	},
	variants: MEAL_SLOTS,
	actions: ['kitchen.removeMealPlanEntry'],
	limit: 4,
	examples: [
		{
			text: 'No fish on Friday after all, we are having pasta instead',
			mentions: [
				{
					kind: 'kitchen.mealOff',
					quote: 'No fish on Friday after all',
					target: 'Fish',
					date: { text: 'Friday', weekday: 5 },
				},
				{
					kind: 'kitchen.meal',
					quote: 'we are having pasta instead',
					title: 'Pasta',
					variant: 'dinner',
					date: { text: 'Friday', weekday: 5 },
				},
			],
			why: 'the planned dish goes, the new one comes',
		},
	],
	decides: {},
	resolve: each(resolveMealOff),
});
