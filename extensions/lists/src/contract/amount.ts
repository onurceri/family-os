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

/**
 * Like `splitAmount`, and also reads an amount with a unit at the end ("Parmesan 150 g"). A
 * leading amount wins when both are there.
 */
export function splitAnyAmount(
	text: string,
	units: readonly string[],
): { title: string; quantity?: string } {
	const line = text.trim();
	const lead = splitAmount(line, amountPattern(units));
	if (lead.quantity) return lead;
	const tail = trailingAmountPattern(units).exec(line);
	if (!tail) return lead;
	return { title: (tail[1] as string).trim(), quantity: (tail[2] as string).trim() };
}
