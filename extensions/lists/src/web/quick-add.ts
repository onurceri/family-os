import { amountOnlyPattern, type ShoppingItemInput, splitAnyAmount } from '../contract/index.js';

/**
 * Turns quick-add text into items: commas or new lines separate items, and an amount becomes the
 * quantity, at the start ("2 kg tomatoes") or, with a unit, at the end ("parmesan 150 g"). A
 * part that is only an amount ("hooks, 4") belongs to the item before it. The units are words of
 * the language packs (`lists:quantity_units`), never of the code.
 */
export function parseQuickAdd(text: string, units: readonly string[]): ShoppingItemInput[] {
	const alone = amountOnlyPattern(units);
	const items: ShoppingItemInput[] = [];
	const parts = text
		.split(/[\n;]|,(?!\d)/) // "1,5 kg" keeps its decimal comma
		.map((part) => part.trim())
		.filter(Boolean);
	for (const part of parts) {
		const previous = items.at(-1);
		if (previous && previous.quantity === undefined && alone.test(part)) {
			previous.quantity = part;
			continue;
		}
		const item = splitAnyAmount(part, units);
		if (item.title.length > 0) items.push(item);
	}
	return items.slice(0, 50);
}
