import { ShoppingListIdSchema } from '@famos/ext-lists/contract';
import { idSchema } from '@famos/sdk';
import { IsoDateSchema } from '@famos/time';
import { z } from 'zod';

/**
 * Kitchen contract: recipes (free-text ingredient lines, no units) and a weekly meal plan.
 * Ingredients are text on purpose; "to the shopping list" hands the lines over unchanged.
 */
export const RecipeIdSchema = idSchema('recipe');
export const MealIdSchema = idSchema('meal');

/** Only for people reviewing a suggestion: which planned meal it is. Never stored. */
export const ReviewLabelSchema = z
	.string()
	.trim()
	.max(200)
	.optional()
	.describe(
		'The planned meal as listed, e.g. "Lentil soup, 2026-10-17 dinner"; only shown to the reviewer',
	);

export const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner', 'other'] as const;
export const MealSlotSchema = z.enum(MEAL_SLOTS);
export type MealSlot = z.infer<typeof MealSlotSchema>;

export const isHttpUrl = (value: string): boolean => {
	try {
		const url = new URL(value);
		return (
			(url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
		);
	} catch {
		return false;
	}
};
const HttpUrlSchema = z.string().trim().max(2000).refine(isHttpUrl, 'Expected a web address');

const LineSchema = (max: number) => z.string().trim().min(1).max(max);

export const RecipeFieldsSchema = z.object({
	title: z.string().trim().min(1).max(160).describe('The name of the dish, as written'),
	servings: z
		.string()
		.trim()
		.max(30)
		.nullable()
		.optional()
		.describe('How many it serves, as written, e.g. "4" or "4–6"'),
	totalMinutes: z
		.number()
		.int()
		.min(1)
		.max(10_080)
		.nullable()
		.optional()
		.describe('Total time in minutes, if stated'),
	ingredients: z
		.array(LineSchema(300))
		.max(100)
		.default([])
		.describe('One ingredient per line, exactly as written, with its amount; no conversions'),
	steps: z.array(LineSchema(3000)).max(100).default([]).describe('One step per entry, in order'),
	notes: z.string().trim().max(4000).nullable().optional(),
	sourceUrl: HttpUrlSchema.nullable().optional().describe('Where the recipe came from, if known'),
	tags: z.array(LineSchema(40)).max(20).default([]).describe('Short labels, e.g. "soup", "quick"'),
});
export type RecipeFields = z.input<typeof RecipeFieldsSchema>;

export const CreateRecipeSchema = RecipeFieldsSchema;
export type CreateRecipeInput = z.input<typeof CreateRecipeSchema>;
export const UpdateRecipeSchema = z.object({ id: RecipeIdSchema, recipe: RecipeFieldsSchema });

export const RecipeSchema = z.object({
	id: z.string(),
	title: z.string(),
	servings: z.string().nullable(),
	totalMinutes: z.number().nullable(),
	ingredients: z.array(z.string()),
	steps: z.array(z.string()),
	notes: z.string().nullable(),
	sourceUrl: z.string().nullable(),
	hasPhoto: z.boolean(),
	tags: z.array(z.string()),
	createdBy: z.string().nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type Recipe = z.infer<typeof RecipeSchema>;

/** The list form: no steps and notes. */
export const RecipeSummarySchema = RecipeSchema.pick({
	id: true,
	title: true,
	servings: true,
	totalMinutes: true,
	hasPhoto: true,
	tags: true,
	updatedAt: true,
});
export type RecipeSummary = z.infer<typeof RecipeSummarySchema>;

export const AddToShoppingSchema = z.object({
	recipeId: RecipeIdSchema,
	/** The ingredient lines to add, as they are in the recipe. */
	lines: z.array(LineSchema(300)).min(1).max(50),
	listId: ShoppingListIdSchema.optional().describe('Target shopping list; omit for the default'),
});

export const MealEntryFieldsSchema = z.object({
	date: IsoDateSchema.describe('The day, YYYY-MM-DD'),
	slot: MealSlotSchema.default('dinner'),
	recipeId: RecipeIdSchema.nullable()
		.optional()
		.describe('A saved recipe (its handle from the recipe list), if it is one'),
	title: z.string().trim().max(160).default('').describe('What is cooked, when it is not a recipe'),
	note: z.string().trim().max(500).nullable().optional(),
});
export const AddToMealPlanSchema = MealEntryFieldsSchema.refine((v) => v.recipeId || v.title, {
	message: 'Name a recipe or write what is cooked',
	path: ['title'],
});
export type AddToMealPlanInput = z.input<typeof AddToMealPlanSchema>;
export const UpdateMealEntrySchema = z.object({
	id: MealIdSchema,
	entry: MealEntryFieldsSchema.refine((v) => v.recipeId || v.title, {
		message: 'Name a recipe or write what is cooked',
		path: ['title'],
	}),
});

export const MealEntrySchema = z.object({
	id: z.string(),
	date: z.string(),
	slot: MealSlotSchema,
	recipeId: z.string().nullable(),
	/** The recipe's title when there is a recipe, else the written title. */
	title: z.string(),
	note: z.string().nullable(),
	createdAt: z.number(),
});
export type MealEntry = z.infer<typeof MealEntrySchema>;

export const kitchenChangedPayload = z.object({ area: z.enum(['recipes', 'meals']) });
