import { FIELD_REASON, type FieldErrors } from '@famos/ui/forms';
import type { Recipe, RecipeReplace } from '../contract/index.js';

/** The recipe form as the inputs hold it: lists are one entry per line. */
export interface RecipeFormValue {
	title: string;
	servings: string;
	minutes: string;
	ingredients: string;
	steps: string;
	notes: string;
	sourceUrl: string;
	tags: string;
}

export const emptyRecipe = (): RecipeFormValue => ({
	title: '',
	servings: '',
	minutes: '',
	ingredients: '',
	steps: '',
	notes: '',
	sourceUrl: '',
	tags: '',
});

export const fromRecipe = (r: Recipe): RecipeFormValue => ({
	title: r.title,
	servings: r.servings ?? '',
	minutes: r.totalMinutes === null ? '' : String(r.totalMinutes),
	ingredients: r.ingredients.join('\n'),
	steps: r.steps.join('\n'),
	notes: r.notes ?? '',
	sourceUrl: r.sourceUrl ?? '',
	tags: r.tags.join(', '),
});

const lines = (text: string) =>
	text
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);

export function toFields(v: RecipeFormValue): RecipeReplace {
	const minutes = Number.parseInt(v.minutes, 10);
	return {
		title: v.title.trim(),
		servings: v.servings.trim() || null,
		totalMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : null,
		ingredients: lines(v.ingredients),
		steps: lines(v.steps),
		notes: v.notes.trim() || null,
		sourceUrl: v.sourceUrl.trim() || null,
		tags: v.tags
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean),
	};
}

export function validate(v: RecipeFormValue): FieldErrors {
	const errors: FieldErrors = {};
	if (!v.title.trim()) errors.title = FIELD_REASON.title;
	if (v.sourceUrl.trim() && !/^https?:\/\/\S+$/i.test(v.sourceUrl.trim()))
		errors.sourceUrl = 'kitchen:error_source_url';
	return errors;
}

/** Whether `url` is safe to open as a link (a web address only). */
export const isWebAddress = (url: string | null): url is string =>
	url !== null && /^https?:\/\//i.test(url);
