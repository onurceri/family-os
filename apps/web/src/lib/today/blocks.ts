import type { TodayBand, TodayBlockContribution } from '@famos/ui/slots';

/**
 * What Today shows (show or hide only; each style keeps its composition). Today is
 * made of blocks: the app's own below, those extensions add (`WebExtension.blocks`) and every
 * `dashboard.card` contribution, by its id. A person, the family or a display keeps a list of the
 * blocks it hides (core's `today.hidden`), so a block that is new, or that this app does not know,
 * is shown by default.
 */

export interface TodayBlock {
	/** The app's own: a plain word (`weather`); an extension's: its id (`chores`, `lists.tasks`). */
	id: string;
	/** Translation key of its name (the app's, or namespaced `<extension>:<key>`). */
	labelKey: string;
	/** Translation key of one line on what it is. */
	hintKey?: string;
}

interface BuiltIn extends TodayBlock {
	/** Its place in the list; extensions place their blocks between these. */
	order: number;
	/** Only on a person's Today (a display has no sentence and nothing to act on). */
	person?: boolean;
	/** Offered only when an extension that is turned on provides it (the weather, the photo). */
	provided?: 'weather' | 'photo';
}

/** The app's own blocks, in the order the settings list shows them (roughly top to bottom). */
const BUILT_INS: readonly BuiltIn[] = [
	{ id: 'clock', order: 10, labelKey: 'app:block_clock', hintKey: 'app:block_clock_hint' },
	{
		id: 'greeting',
		order: 20,
		labelKey: 'app:block_greeting',
		hintKey: 'app:block_greeting_hint',
		person: true,
	},
	{
		id: 'weather',
		order: 30,
		labelKey: 'app:block_weather',
		hintKey: 'app:block_weather_hint',
		provided: 'weather',
	},
	{
		id: 'photo',
		order: 40,
		labelKey: 'app:block_photo',
		hintKey: 'app:block_photo_hint',
		provided: 'photo',
	},
	{ id: 'next', order: 50, labelKey: 'app:block_next', hintKey: 'app:block_next_hint' },
	{ id: 'day', order: 60, labelKey: 'app:block_day', hintKey: 'app:block_day_hint' },
	{ id: 'family', order: 70, labelKey: 'app:block_family', hintKey: 'app:block_family_hint' },
	{
		id: 'needs',
		order: 90,
		labelKey: 'app:block_needs',
		hintKey: 'app:block_needs_hint',
		person: true,
	},
	{
		id: 'nextDays',
		order: 110,
		labelKey: 'app:block_next_days',
		hintKey: 'app:block_next_days_hint',
	},
	{ id: 'done', order: 120, labelKey: 'app:block_done', hintKey: 'app:block_done_hint' },
];

/** The ids of the app's own blocks. */
export const BUILT_IN_BLOCKS: readonly string[] = BUILT_INS.map((b) => b.id);

/** What the blocks list needs of a `dashboard.card` contribution. */
export interface CardLike {
	id: string;
	band?: TodayBand;
	/** One of its extension's blocks, which shows or hides it. */
	block?: string;
	labelKey?: string;
	hintKey?: string;
}

/**
 * The block that decides whether a card shows: the cards of the `needs` band are Needs you, a
 * card that names a block of its extension that block, any other card is a block of its own.
 */
export const blockOfCard = (card: CardLike): string =>
	card.band === 'needs' ? 'needs' : (card.block ?? card.id);

/** Whether a block shows, given what is hidden. */
export const shows = (hidden: ReadonlySet<string> | readonly string[], block: string): boolean =>
	hidden instanceof Set ? !hidden.has(block) : !(hidden as readonly string[]).includes(block);

/**
 * The blocks a viewer can choose from, in order: the app's own (a display without the person's
 * own; the weather and the photo only when something provides them) with the blocks extensions
 * add (`added`, of extensions that are turned on) between them, then the cards that are blocks of
 * their own, named by their `labelKey` or else by their extension's name (`extensionLabel`).
 */
export function todayBlocks(
	cards: readonly CardLike[],
	options: {
		familyMode?: boolean;
		added?: readonly TodayBlockContribution[];
		provided?: { weather?: boolean; photo?: boolean };
		extensionLabel?: (extensionId: string) => string | undefined;
	} = {},
): TodayBlock[] {
	const placed = [
		...BUILT_INS.filter(
			(b) => !(options.familyMode && b.person) && !(b.provided && !options.provided?.[b.provided]),
		),
		...(options.added ?? []),
	]
		.toSorted((a, b) => a.order - b.order)
		.map(({ id, labelKey, hintKey }) => ({ id, labelKey, ...(hintKey && { hintKey }) }));
	const seen = new Set(placed.map((b) => b.id));
	const fromCards: TodayBlock[] = [];
	for (const card of cards) {
		const id = blockOfCard(card);
		if (id !== card.id || seen.has(id)) continue;
		seen.add(id);
		const ext = id.split('.')[0] ?? id;
		const labelKey = card.labelKey ?? options.extensionLabel?.(ext) ?? id;
		fromCards.push({ id, labelKey, ...(card.hintKey && { hintKey: card.hintKey }) });
	}
	return [...placed, ...fromCards];
}

/** Whether nothing that could show is shown (Today then says so, with a way back). */
export const everythingHidden = (
	blocks: readonly TodayBlock[],
	hidden: ReadonlySet<string> | readonly string[],
): boolean => blocks.length > 0 && blocks.every((b) => !shows(hidden, b.id));

/**
 * The hidden list after showing or hiding one block. Ids of blocks this viewer cannot see (a
 * card of an extension that is off, a block of a future version) are kept as they are.
 */
export function withBlock(hidden: readonly string[], block: string, show: boolean): string[] {
	const rest = hidden.filter((id) => id !== block);
	return show ? rest : [...rest, block];
}
