/** Input fields that name what a suggestion is about, most specific first. */
const NAMING_FIELDS = ['title', 'name', 'text', 'body', 'summary', 'label'] as const;

/**
 * What a suggestion is about, in the words of its input: the title or name of a new thing, the
 * review label of an existing one, or the titles of several items joined. Undefined when the input
 * names nothing (or is not valid JSON, as one stored by an older version may not be).
 */
export function subjectOf(inputJson: string): string | undefined {
	let input: unknown;
	try {
		input = JSON.parse(inputJson);
	} catch {
		return undefined;
	}
	if (typeof input !== 'object' || input === null) return undefined;
	const fields = input as Record<string, unknown>;
	for (const key of NAMING_FIELDS) {
		const value = fields[key];
		if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 80);
	}
	const items = fields.items;
	if (Array.isArray(items)) {
		const titles = items
			.map((item) =>
				typeof item === 'object' && item !== null && 'title' in item ? item.title : undefined,
			)
			.filter((title): title is string => typeof title === 'string' && title.trim() !== '')
			.map((title) => title.trim());
		if (titles.length > 0) return titles.join(', ').slice(0, 80);
	}
	return undefined;
}
