import {
	amountOnlyPattern,
	amountPattern,
	type ShoppingItemInput,
	splitAmount,
} from '@famos/ext-lists/contract';

/** Shopping item limits (lists contract). */
const TITLE_MAX = 120;
const QUANTITY_MAX = 40;

/**
 * The words that read an ingredient line, from the language packs: units ("tbsp", "tin"), words
 * that join an amount to the product ("2 cups of flour"), and preparation notes ("crumbled",
 * "finely chopped") that say how to use it rather than what to buy.
 */
export interface IngredientWords {
	units: readonly string[];
	links: readonly string[];
	preparation: readonly string[];
}

/** A line's words, lower-cased, letters and digits only, as one space-separated string. */
const normalWords = (text: string, locale: string) =>
	` ${text
		.toLocaleLowerCase(locale)
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean)
		.join(' ')} `;

const hasPhrase = (text: string, phrases: readonly string[], locale: string) => {
	const words = normalWords(text, locale);
	return phrases.some((phrase) => {
		const wanted = normalWords(phrase, locale);
		return wanted.trim() !== '' && words.includes(wanted);
	});
};

const capitalise = (text: string, locale: string) => {
	const [first = '', ...rest] = text;
	return first.toLocaleUpperCase(locale) + rest.join('');
};

/**
 * Reads a recipe's ingredient line as a shopping item: "60 g feta, crumbled" becomes "Feta" with
 * the quantity "60 g"; "1 tin chopped tomatoes (400 g)" becomes "Chopped tomatoes", "1 tin
 * (400 g)". A note after a comma is dropped when it names a preparation, and one that is only an
 * amount ("Lime, 1") becomes the quantity; an amount in brackets joins the quantity and other
 * bracketed notes are dropped. Null for a line with no product.
 */
export function ingredientToItem(
	line: string,
	words: IngredientWords,
	locale: string,
	pattern: RegExp = amountPattern(words.units),
): ShoppingItemInput | null {
	const extraAmounts: string[] = [];
	const withoutBrackets = line
		.replace(/\(([^()]*)\)/g, (_, inner: string) => {
			if (/\d/.test(inner)) extraAmounts.push(`(${inner.trim()})`);
			return ' ';
		})
		.replace(/\s+/g, ' ')
		.trim();

	const [head = '', ...notes] = withoutBrackets.split(/,(?!\d)/);
	const alone = amountOnlyPattern(words.units);
	const kept = notes.filter((note) => note.trim() && !hasPhrase(note, words.preparation, locale));
	// A note that is only an amount ("Lime, 1") is the quantity, not part of the name.
	const noteAmount = kept.find((note) => alone.test(note.trim()))?.trim();
	const named = kept.filter((note) => note.trim() !== noteAmount);
	const split = splitAmount([head, ...named].map((part) => part.trim()).join(', '), pattern);
	const name = split.title;
	const quantity = split.quantity ?? noteAmount;

	let title = name;
	if (quantity) {
		const lower = title.toLocaleLowerCase(locale);
		const link = words.links.find((word) => word && lower.startsWith(`${word} `));
		if (link) title = title.slice(link.length).trim();
	}
	title = title.replace(/^[\s,;:.\-–]+|[\s,;:.\-–]+$/g, '');
	if (!title) return null;

	const amount = quantity
		? [quantity, ...extraAmounts].join(' ')
		: extraAmounts.map((a) => a.slice(1, -1)).join(' ');
	return {
		title: capitalise(title, locale).slice(0, TITLE_MAX),
		...(amount && { quantity: amount.slice(0, QUANTITY_MAX) }),
	};
}
