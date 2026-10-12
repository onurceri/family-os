import { idSchema } from '@famos/sdk';
import { IsoDateSchema, IsoTimeSchema, RecurrenceSchema } from '@famos/time';
import { z } from 'zod';

export {
	amountOnlyPattern,
	amountPattern,
	splitAmount,
	splitAnyAmount,
	titleKey,
	trailingAmountPattern,
} from './amount.ts';

/**
 * Lists contract: tasks and shopping, shared by the server, the web UI and other extensions.
 * Dates and times are local to the family time zone.
 */
export const TaskIdSchema = idSchema('task');
export const ShoppingListIdSchema = idSchema('shop_list');
export const ShoppingItemIdSchema = idSchema('shop_item');
export const MemberIdSchema = idSchema('member');

/**
 * Tells the reviewer which task or item it is. For an AI it is the guard against acting on the
 * wrong one: the person's own words, which must name the target. The runner stores the real
 * title here on every draft.
 */
export const ReviewLabelSchema = z
	.string()
	.trim()
	.max(200)
	.optional()
	.describe(
		'Required for you: the name the person used for this task or item, in their words, not the listed title. If nothing listed fits those words, do not call this tool: tell the person it is not on the list.',
	);

/** The longest task title; screens count toward it and refuse a longer one. */
export const TASK_TITLE_MAX = 160;
/** The longest shopping item title and quantity. */
export const SHOPPING_TITLE_MAX = 120;
export const SHOPPING_QUANTITY_MAX = 40;

export const TaskInputSchema = z
	.object({
		title: z
			.string()
			.trim()
			.min(1)
			.max(TASK_TITLE_MAX)
			.describe('What needs doing, e.g. "Pay the school trip fee"'),
		assigneeId: MemberIdSchema.nullable()
			.optional()
			.describe('The member who should do it; omit or null when anyone can'),
		dueDate: IsoDateSchema.nullable()
			.optional()
			.describe('Deadline, YYYY-MM-DD, in the family time zone'),
		dueTime: IsoTimeSchema.nullable()
			.optional()
			.describe('Deadline time HH:MM; only with a due date'),
		recurrence: RecurrenceSchema.nullable()
			.optional()
			.describe('Repeat rule for chores; requires a due date (the first occurrence)'),
		notes: z.string().trim().max(2000).nullable().optional(),
	})
	.superRefine((v, ctx) => {
		if (v.dueTime && !v.dueDate)
			ctx.addIssue({ code: 'custom', path: ['dueTime'], message: 'A due time needs a due date' });
		if (v.recurrence && !v.dueDate) {
			ctx.addIssue({
				code: 'custom',
				path: ['dueDate'],
				message: 'A repeating task needs a due date',
			});
		}
	});
export type TaskInput = z.input<typeof TaskInputSchema>;

export const TaskSchema = z.object({
	id: z.string(),
	title: z.string(),
	notes: z.string().nullable(),
	assigneeId: z.string().nullable(),
	/** Next due date; for repeating tasks it moves forward on completion. */
	dueDate: z.string().nullable(),
	dueTime: z.string().nullable(),
	recurrence: RecurrenceSchema.nullable(),
	/** Raw RRULE when the rule is outside the editable presets. */
	rrule: z.string().nullable(),
	/** Set when a one-off task (or a finished series) is done. */
	doneAt: z.number().nullable(),
	doneBy: z.string().nullable(),
});
export type Task = z.infer<typeof TaskSchema>;

/** Store-section order: the order categories appear in on the shopping list. */
export const CATEGORIES = [
	'produce',
	'bakery',
	'dairy',
	'meat',
	'pantry',
	'frozen',
	'drinks',
	'snacks',
	'household',
	'personal',
	'baby',
	'pets',
	'other',
] as const;
export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

export const ShoppingItemInputSchema = z.object({
	title: z.string().trim().min(1).max(SHOPPING_TITLE_MAX).describe('The product, e.g. "Milk"'),
	quantity: z
		.string()
		.trim()
		.max(SHOPPING_QUANTITY_MAX)
		.nullable()
		.optional()
		.describe('Free text, e.g. "2 kg" or "3"'),
	category: CategorySchema.optional().describe(
		'Store section; omit to reuse the last one used for this product',
	),
});
export type ShoppingItemInput = z.input<typeof ShoppingItemInputSchema>;

export const AddShoppingItemsSchema = z.object({
	listId: ShoppingListIdSchema.optional().describe(
		'Target list; omit for the first (default) list',
	),
	items: z.array(ShoppingItemInputSchema).min(1).max(50),
	/**
	 * What happens to an item that is already on the list and not bought yet: `update` (the
	 * default) takes the new quantity and category, `keep` leaves it exactly as it is. A bought
	 * item comes back either way.
	 */
	whenOnList: z.enum(['keep', 'update']).optional(),
});
export type AddShoppingItemsInput = z.input<typeof AddShoppingItemsSchema>;

export const ShoppingItemSchema = z.object({
	id: z.string(),
	listId: z.string(),
	title: z.string(),
	quantity: z.string().nullable(),
	category: CategorySchema,
	doneAt: z.number().nullable(),
	addedBy: z.string().nullable(),
});
export type ShoppingItem = z.infer<typeof ShoppingItemSchema>;

export const ShoppingListSchema = z.object({
	id: z.string(),
	/** Empty for the list made on install: screens show their translated default name. */
	name: z.string(),
	openCount: z.number().int(),
});
export type ShoppingList = z.infer<typeof ShoppingListSchema>;

/** Short enough to sit in a chip next to the others. */
export const LIST_NAME_MAX = 30;
export const ListNameSchema = z.string().trim().min(1).max(LIST_NAME_MAX);

export const taskChangedPayload = z.object({ taskId: z.string() });
export const shoppingChangedPayload = z.object({ listId: z.string() });
