import {
	amountOnlyPattern,
	amountPattern,
	SHOPPING_QUANTITY_MAX,
	SHOPPING_TITLE_MAX,
	type ShoppingItemInput,
	splitAmount,
} from '@famos/ext-lists/contract';

/**
 * The words that read an ingredient line, from the language packs: units ("tbsp", "tin") and
 * words that join an amount to the product ("2 cups of flour").
 */
export interface IngredientWords {
	units: readonly string[];
	links: readonly string[];
}

const capitalise = (text: string, locale: string) => {
	const [first = '', ...rest] = text;
	return first.toLocaleUpperCase(locale) + rest.join('');
};

/**
 * Reads a recipe's ingredient line as a shopping item: "60 g feta, crumbled" becomes "Feta" with
 * the quantity "60 g"; "1 tin chopped tomatoes (400 g)" becomes "Chopped tomatoes", "1 tin
 * (400 g)". Whatever follows a comma is a note on how to use the product ("zest and juice",
 * "finely chopped") and never reaches the title; a note that is only an amount ("Lime, 1")
 * becomes the quantity. An amount in brackets joins the quantity and other bracketed notes are
 * dropped. Null for a line with no product.
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
	// A note that is only an amount ("Lime, 1") is the quantity; every other note is dropped.
	const noteAmount = notes.find((note) => alone.test(note.trim()))?.trim();
	const split = splitAmount(head.trim(), pattern);
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
		title: capitalise(title, locale).slice(0, SHOPPING_TITLE_MAX),
		...(amount && { quantity: amount.slice(0, SHOPPING_QUANTITY_MAX) }),
	};
}
