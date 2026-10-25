import type { PresenterMember } from './drafts.ts';

/** One thing on the day's timeline (Today, and the phone calendar's agenda). */
export interface TimelineItem {
	id: string;
	/** Epoch ms; `allday`, `anytime` and `evening` items have no start. */
	start?: number;
	end?: number;
	slot?: 'allday' | 'anytime' | 'evening';
	title: string;
	subtitle?: string;
	/** Where it happens, as entered (the next-up pill's `At <place>`); also part of `subtitle`. */
	location?: string;
	/** Member ids; the first one gives the dot its colour. Empty means the whole family. */
	members?: readonly string[];
	kind: 'event' | 'meal' | 'chore' | 'task';
	done?: boolean;
	href: string;
	/** When set the row is a button that calls it, instead of a link to `href` (the phone agenda). */
	onselect?: () => void;
	/**
	 * `start` only places the item in the order (a meal plan has no clock): no time is shown and
	 * the item is never "next".
	 */
	nominal?: boolean;
}

/** What a timeline contribution may use from the app (a subset of `useApp()`). */
export interface TimelineApp {
	t(key: string, options?: Record<string, unknown>): string;
	formatLocale(): string;
	dateLocale(): string;
	hourCycle(): 'h12' | 'h23';
	timeZone(): string;
	members(): readonly PresenterMember[];
}

export interface TimelineContribution {
	/** Unique, namespaced: `<extension>.<name>`. */
	id: string;
	/**
	 * Capability needed to read it. A family display has a day (the next thing, the day by person)
	 * when it holds the `requires` of any timeline contribution.
	 */
	requires: string;
	/** The page that shows the whole day: Today's day and the next days link to it. */
	page?: string;
	/**
	 * Items for one calendar day (`YYYY-MM-DD` in the family's time zone). Called for today and
	 * tomorrow; `app` gives the time zone, formats and translations.
	 */
	load(day: string, app: TimelineApp): Promise<readonly TimelineItem[]>;
	/**
	 * The look-ahead of a light day ("Next days"): items from `from` to `to` (both `YYYY-MM-DD`,
	 * inclusive), each with its day. Only for things worth seeing days ahead (events); a
	 * contribution without it is left out of the look-ahead.
	 */
	loadAhead?(from: string, to: string, app: TimelineApp): Promise<readonly DayItem[]>;
	/** Event prefixes whose arrival should reload (`'calendar.'`). */
	invalidateOn?: readonly string[];
}

/** A timeline item on a given day (`YYYY-MM-DD` in the family's time zone). */
export interface DayItem extends TimelineItem {
	day: string;
}

/**
 * Something Today shows in a shape of its own, not as a card: each style decides where and how
 * (Broadsheet's rings, Lanes' bars and weather row, Wall's tiles). A style shows a facet only
 * when an extension that is turned on provides it and the viewer holds its `requires`; with
 * several of one kind, the first (by extension) is used.
 */
export type TodayFacet =
	| MemberCountsFacet
	| MemberStatusFacet
	| PhotoFacet
	| WeatherFacet
	| SetupHintFacet;

interface FacetBase {
	/** Unique, namespaced: `<extension>.<name>`. */
	id: string;
	/** Capability needed to read it (a display's too). */
	requires: string;
	/** Event prefixes whose arrival should reload (`'chores.'`). */
	invalidateOn?: readonly string[];
}

/** How far one person is with the day's things (`memberId: null`: anyone's). */
export interface MemberCount {
	memberId: string | null;
	done: number;
	total: number;
}

/**
 * Things of the day counted per person (chores): rings or bars, the "2 left" under a person's
 * day, a display's total. `block` is the extension's block that shows or hides it; `href` the
 * page the rings open. The words are translation keys: `titleKey` the section ("Chores today"),
 * `labelKey` its short name ("Chores"), `ringKey` one ring (`name`, `done`, `total`), `noneKey`
 * a ring with nothing to count today (`name`; `ringKey` when not given), `leftKey` what is left
 * for a person (`count`, with plural forms).
 */
export interface MemberCountsFacet extends FacetBase {
	kind: 'perMember';
	block: string;
	href?: string;
	titleKey: string;
	labelKey: string;
	ringKey: string;
	noneKey?: string;
	leftKey: string;
	load(app: TimelineApp): Promise<readonly MemberCount[]>;
}

/** A few words about one person right now, already in the reader's language ("Home", "At School"). */
export interface MemberNote {
	memberId: string;
	/** Short: it stands beside a name. */
	text: string;
}

/**
 * A word about each person, beside their name wherever a style draws people (the family list,
 * the day by person, the lanes): where they are, say. Only people the extension has something
 * about are in `load`'s answer; the others show nothing. Notes of several such facets stand side
 * by side. They have no tone: what is said about a person is never coloured. `block` is the
 * extension's block that shows or hides them. `refreshMs`: how often to read again while the page
 * is open, for what changes without an event of FamilyOS.
 */
export interface MemberStatusFacet extends FacetBase {
	kind: 'memberStatus';
	block?: string;
	refreshMs?: number;
	load(app: TimelineApp): Promise<readonly MemberNote[]>;
}

/** The photo of the day: where it loads from and the month it is from (`YYYY-MM`); null for none. */
export interface PhotoFacet extends FacetBase {
	kind: 'photo';
	load(app: TimelineApp): Promise<{ src: string; month: string } | null>;
}

/**
 * The next hours of the weather, for a style that draws them itself (Lanes' weather row); null
 * when there is no forecast. `refreshMs`: how often to read it again while the page is open.
 */
export interface WeatherFacet extends FacetBase {
	kind: 'weather';
	refreshMs?: number;
	load(
		app: TimelineApp,
	): Promise<{ hours: readonly WeatherHour[]; min: number; max: number } | null>;
}

/** One hour of a forecast (the same shape as `HourlyPoint` of `@famos/ui/famos`). */
export interface WeatherHour {
	/** Epoch ms of the hour's start. */
	at: number;
	temperature: number;
	/** WMO weather code. */
	code: number;
	precipitationProbability?: number | null;
}

/**
 * A step of the first steps a new family sees on Today ("Set your city"), between the app's own
 * (the people) and the AI. `load` says whether it is done; a failed load counts as done. With
 * `fresh` its answer also says whether the family is new: it is asked only while the family has
 * one person, and while no such step is done Today greets a new family with the first steps.
 * The keys are the step's title, one line on it and its button; `order` places it among others.
 */
export interface SetupHintFacet extends FacetBase {
	kind: 'setupHint';
	order?: number;
	fresh?: boolean;
	titleKey: string;
	textKey: string;
	actionKey: string;
	href: string;
	load(app: TimelineApp): Promise<boolean>;
}

/**
 * A block of Today an extension adds to "What Today shows", where each person, the family and a
 * display may hide it. Its id is the extension's id or namespaced (`<extension>.<name>`), and it
 * is what a card's or a facet's `block` names. `order` places it among the app's own blocks (10
 * the clock … 120 the evening's done line, in tens). `titleKey` is the heading Today gives it when
 * that differs from its name. With `items` the block is the day's things of that kind as a list
 * of their own (the meals).
 */
export interface TodayBlockContribution {
	id: string;
	labelKey: string;
	hintKey?: string;
	order: number;
	titleKey?: string;
	items?: TimelineItem['kind'];
}
