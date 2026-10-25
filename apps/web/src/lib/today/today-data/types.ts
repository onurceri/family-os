import type { ChoreCount } from '@famos/ui/famos';
import type { SlotContribution, TimelineItem } from '@famos/ui/slots';
import type { family } from '#lib/family.svelte.js';
import type { session } from '#lib/session.svelte.js';

export type Card = SlotContribution<'dashboard.card'>;
export interface PhotoOfTheDay {
	src: string;
	label: string;
}

/** What Today needs of a member (a preview's made-up people and a display's have only this). */
export type FamilyMember = Pick<(typeof family.members)[number], 'id' | 'displayName' | 'color'>;
/** The person Today is for: what the compositions and the sentence need of them. */
export type TodayMe = Pick<NonNullable<typeof session.me>, 'id' | 'displayName' | 'nextUp'>;

/**
 * A made-up day for a preview (Settings → Appearance): the people, the time and the day's things
 * are given instead of loaded. Nothing is read from the API, no card or extension is mounted and
 * the page is settled at once. The family's time zone and formats still apply.
 */
export interface TodaySample {
	now: number;
	members: readonly FamilyMember[];
	me: TodayMe | null;
	todayItems: TimelineItem[];
	tomorrowItems: TimelineItem[];
	chores: ChoreCount[];
}

/**
 * A family display (family mode): who views is the display itself, through the `AppContext` the
 * display page provides (its capabilities, the family's formats and time zone, the members when
 * names are shown). `showNames` is fixed for the data's life: the page makes a new one when it
 * changes, so no name stays behind in an item already loaded.
 */
export interface TodayFamilyMode {
	showNames: boolean;
	/** Extensions turned off for the family (reactive). */
	disabledExtensions(): readonly string[];
}

export interface TodayOptions {
	/** A preview: everything comes from it and nothing is loaded. */
	sample?: TodaySample;
	/** A family display: no person, only what the display may read. */
	familyMode?: TodayFamilyMode;
	/**
	 * The blocks this Today hides (the person's or the display's choice; see `blocks.ts`), and
	 * whether that choice is known yet (the page waits for it, so it composes once).
	 */
	hidden?: () => readonly string[];
	hiddenKnown?: () => boolean;
	/** Hides a block from this Today (a person's: the `...` of a block's label offers it). */
	hide?: (block: string) => void;
}
