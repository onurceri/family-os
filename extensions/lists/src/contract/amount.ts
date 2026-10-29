/**
 * Reading a leading amount off a shopping line ("2 kg tomatoes", "½ cup milk"), shared by the
 * shopping page's quick add and by other extensions that put things on the list. The units are
 * words of the language packs, passed in by the caller; this module holds none.
 */

/**
 * The key that matches an item to one already on a list: case and spacing do not count. It is
 * lower-cased with the family's locale, so letters like the Turkish dotted I fold correctly.
 */
export function titleKey(title: string, locale: string): string {
	return title.trim().replace(/\s+/g, ' ').toLocaleLowerCase(locale);
}

const escapeRegex = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Single-character fractions ("½", "¾") that recipes and labels use. */
const VULGAR = '\\u00BC-\\u00BE\\u2150-\\u215E';
/** One number: "1 1/2", "1/2", "1½", "1,5", "2", "½". */
const NUMBER = `(?:\\d+\\s+\\d+\\s*\\/\\s*\\d+|\\d+\\s*\\/\\s*\\d+|\\d+(?:[.,]\\d+)?(?:\\s*[${VULGAR}])?|[${VULGAR}])`;
/** A number or a range of two ("2-3"). */
const AMOUNT = `${NUMBER}(?:\\s*[-\\u2013]\\s*${NUMBER})?`;

/** A leading amount with an optional unit: "2", "1,5 kg", "500g", "2x", "½ cup". */
export function amountPattern(units: readonly string[]): RegExp {
	return new RegExp(`^(${AMOUNT}\\s*${unitGroup(units)}\\.?)\\s+(.+)$`, 'iu');
}

/** The units as one optional regex group, longest first so "fl oz" wins over "fl". */
function unitGroup(units: readonly string[], required = false): string {
	const words = units
		.map((u) => u.trim())
		.filter(Boolean)
		.toSorted((a, b) => b.length - a.length)
		.map(escapeRegex);
	if (!words.length) return '';
	return `(?:${words.join('|')})${required ? '' : '?'}`;
}

/** A trailing amount with a unit: "Parmesan 150 g". The unit is required so "iPhone 15" stays whole. */
export function trailingAmountPattern(units: readonly string[]): RegExp {
	const group = unitGroup(units, true);
	// Without units there is nothing to tell an amount from a number in a name.
	if (!group) return /(?!)/u;
	return new RegExp(`^(.+?)\\s+(${AMOUNT}\\s*${group}\\.?)$`, 'iu');
}

/** Text that is only an amount, with an optional unit: "4", "2 kg". */
export function amountOnlyPattern(units: readonly string[]): RegExp {
	return new RegExp(`^(${AMOUNT}\\s*${unitGroup(units)}\\.?)$`, 'iu');
}

/**
 * Splits a leading amount off a line: "2 kg tomatoes" gives the title "tomatoes" and the
 * quantity "2 kg". A line without an amount is all title.
 */
export function splitAmount(text: string, pattern: RegExp): { title: string; quantity?: string } {
	const line = text.trim();
	const match = pattern.exec(line);
	if (!match) return { title: line };
	return { title: (match[2] as string).trim(), quantity: (match[1] as string).trim() };
}

/** The first letter in upper case by the language's own rule ("istanbul" becomes "İstanbul" in Turkish). */
export function capitalize(text: string, language: string): string {
	const [first] = text;
	return first === undefined ? text : first.toLocaleUpperCase(language) + text.slice(first.length);
}

/**
 * A title as a list entry: a capital first letter in `language` ("bread" becomes "Bread"), as
 * every item on the list has, however it was typed. A name whose first word has a capital
 * inside it is written its own way and kept ("iPhone charger", "eBay parcel").
 */
export function listEntry(title: string, language: string): string {
	const firstWord = title.split(/\s/u)[0] ?? '';
	return /\p{Lu}/u.test(firstWord.slice(1)) ? title : capitalize(title, language);
}

/**
 * Like `splitAmount`, and also reads an amount with a unit at the end ("Parmesan 150 g"). A
 * leading amount wins when both are there. With `language` the title is a list entry
 * (`listEntry`), so "2 kg tomatoes, bread" gives "Tomatoes" and "Bread" alike.
 */
export function splitAnyAmount(
	text: string,
	units: readonly string[],
	language?: string,
): { title: string; quantity?: string } {
	const line = text.trim();
	const entry = (item: { title: string; quantity?: string }) =>
		language ? { ...item, title: listEntry(item.title, language) } : item;
	const lead = splitAmount(line, amountPattern(units));
	if (lead.quantity) return entry(lead);
	const tail = trailingAmountPattern(units).exec(line);
	if (!tail) return entry(lead);
	return entry({ title: (tail[1] as string).trim(), quantity: (tail[2] as string).trim() });
}

const AMOUNT_START = new RegExp(`^${AMOUNT}`, 'u');
const SEPARATOR = ' + ';

/** What an amount counts in: "2 L" gives "l", "3" gives "" ("a dozen" is all unit). */
export function quantityUnit(quantity: string): string {
	return quantity
		.trim()
		.replace(AMOUNT_START, '')
		.replace(/\.$/u, '')
		.trim()
		.replace(/\s+/gu, ' ')
		.toLowerCase();
}

/**
 * The amount an item has once `added` is asked for on top of `existing`. An amount in the same
 * unit replaces the one on the list (asking again for "3 L" means 3, not 5), and one in another
 * unit sits beside it ("2 L + 2"): the two cannot be added up without knowing the product, and
 * dropping the unit would lose what the list said. Asking for the same amount twice changes
 * nothing, so a retried add is safe.
 */
export function mergeQuantity(
	existing: string | null,
	added: string | null | undefined,
): string | null {
	const next = added?.trim();
	if (!next) return existing;
	const current = existing?.trim();
	if (!current) return next;
	const parts = current
		.split(SEPARATOR)
		.map((p) => p.trim())
		.filter(Boolean);
	const unit = quantityUnit(next);
	const at = parts.findIndex((p) => quantityUnit(p) === unit);
	if (at === -1) parts.push(next);
	else parts[at] = next;
	return parts.join(SEPARATOR);
}
