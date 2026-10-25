import type { Component } from 'svelte';

/**
 * Where a Today contribution sits on the page. `foot` is
 * the last line of the page: quiet links (Ask the assistant) that never count as content.
 */
export type TodayBand = 'needs' | 'day' | 'notes' | 'ahead' | 'foot';

/** What a Today card tells the page about itself; the page decides what to show from it. */
export interface TodayReport {
	/** How many things the section has right now; 0 collapses it into the quiet line. */
	count: number;
	/** Translation key of the phrase the quiet line uses when the count is 0 ("no chores"). */
	quietKey: string;
	/** Passed to `quietKey` as `count`, for phrases that name a number ("2 suggestions waiting"). */
	quietCount?: number;
	/** How many of them are for now or overdue; lifts the section within its band. */
	urgent?: number;
}

declare global {
	/**
	 * The slots extensions add (an extension that owns a slot declares it from its contract), so
	 * the page that renders it and the extensions that contribute to it share one type:
	 *
	 * ```ts
	 * declare global {
	 *   interface FamosExtensionSlots {
	 *     'record.section': { recordId: string; recordKind: string; recordName: string };
	 *   }
	 * }
	 * ```
	 *
	 * Global rather than an augmentation of this module: a Svelte component of this package that
	 * another package's checker reaches through a link can see a copy of this module that an
	 * augmentation does not reach, while every copy shares the globals.
	 */
	interface FamosExtensionSlots {}
}

/** The slots of the app, and those extensions add (`FamosExtensionSlots`). */
export interface SlotProps extends FamosExtensionSlots {
	/**
	 * A section of Today. The page mounts every card once
	 * and waits for its first `report`; a card renders only `TodaySection` / `TodayRow` shapes (the
	 * page owns the chrome and spacing) and renders nothing at `size: 'line'`.
	 */
	'dashboard.card': {
		/** The band the page put the card in; it renders that band's shape. */
		band: TodayBand;
		/** How much room it has; `line` means "render nothing, the page shows the quiet line". */
		size: 'wide' | 'half' | 'line';
		/** Tell the page what the card has; call it whenever its data changes. */
		report(r: TodayReport): void;
		/**
		 * The shape the style asks for. `rows` (the default): the card's section of rows.
		 * `glance`: the day at a glance, for contributions declared `glance`: render the card's
		 * glanceable shape (a `BigNumber`: "9 items to get"), or nothing when the page already
		 * shows it from the extension's route (chores: the rings of `GET /chores/today`). A card
		 * reports the same either way.
		 */
		form?: 'rows' | 'glance';
	};
	/**
	 * Small controls at the end of the Today page head on phones (the notifications bell). The
	 * app contributes to it (`apps/web/src/lib/app-slots.ts`), not an extension.
	 */
	'today.head': Record<string, never>;
	/**
	 * The weather on Today; render nothing when there is nothing to say. `line` (the default): one
	 * quiet line beside the time. `block`: the weather of a style's Today: the
	 * temperature as a big number, the sentence that links it to the day and the next hours
	 * (`variant` and `strip` follow the style). The page waits for `report` before it shows
	 * itself, so the block never arrives after the rest (it composes once).
	 */
	'today.atmosphere': {
		form?: 'line' | 'block';
		/** `serif`: the sentence in the serif slot (Broadsheet); `plain`: the body face (Wall). */
		variant?: 'serif' | 'plain';
		/** The next hours as `tiles` (Broadsheet) or `bars` (Wall). */
		strip?: 'tiles' | 'bars' | 'none';
		/** A family display: it only looks, so nothing in it is a link (the source is plain text). */
		familyMode?: boolean;
		/** Whether it shows something; call it once its data is in, and whenever that changes. */
		report?(r: { shown: boolean }): void;
	};
	/** A capture box offered on Today for a family that is just starting out. */
	'today.capture': Record<string, never>;
	/**
	 * An icon button in the head row of the sidebar (windows 1024 px and more, `variant: 'sidebar'`,
	 * 36 px) or at the top of the tablet rail (`'rail'`, 44 px), for an action that works from any page (Quick
	 * add opens its capture box in a side panel). The contribution renders its own button and
	 * whatever it opens; phones use the navigation entry only.
	 */
	'nav.action': { variant: 'sidebar' | 'rail' };
	/**
	 * A tile in the band at the foot of a family display (`/display`), for
	 * what the display's Today does not show (Today in family mode already has the day, chores,
	 * the weather, the photo and the cards with a glance). Read-only: no links, no buttons. It runs
	 * as the display, so it may only call routes of view capabilities the display was granted.
	 * `rows`: the most rows (or papers) the screen has room for, the rest as "+n"; without it the
	 * widget's own limit. A display shortens its widgets before it leaves one out.
	 */
	'display.widget': { rows?: number };
	/**
	 * A compact status pill beside the clock of a family display ("2 suggestions waiting").
	 * Build it with `DisplayPill` from `@famos/ui/famos`; render nothing when there is nothing to
	 * say. Read-only, like widgets.
	 */
	'display.status': Record<string, never>;
	/**
	 * Covers the display's Today when nobody has touched it for a while (ambient mode). The
	 * contribution decides itself when to show (it sees `useApp().can(…)`), and takes itself away
	 * on any interaction. `time` and `date` are the display's formatted clock.
	 */
	'display.ambient': {
		time: string;
		date: string;
		/** Called with `true` when ambient mode starts covering the display and `false` when it ends. */
		onactive?: (active: boolean) => void;
		/**
		 * Whether ambient mode may take the display over when nobody touches it. The display passes
		 * false while it has pages in its rotation, since they would be hidden behind the cover (an
		 * extension offers what ambient mode shows as a `display.page` instead). Left out, true.
		 */
		idle?: boolean;
	};
	/**
	 * A full-screen page a family display can show between Today's turns, chosen per display in
	 * Settings → Devices. Read-only (no links, no buttons): it runs as the display, so it may only
	 * call routes of view capabilities the display was granted. It must fit its box without
	 * scrolling and say "N more" when it has more than fits. It is mounted the first time it is
	 * shown and stays mounted; `shown` is true while it is on screen, so it can read again when it
	 * comes round. `labelKey` is the page's name in Settings and in the page's head on the screen.
	 */
	'display.page': { shown: boolean };
	/**
	 * An optional step of first-run setup, shown after the founder's account exists and they are
	 * signed in (they hold every capability). It must never block setup: it offers Skip and calls
	 * `done` when it is finished or skipped.
	 */
	'setup.step': { done: () => void };
	/**
	 * A line in Settings, Devices & displays, under the devices: where else the family chooses what
	 * displays show (a settings page of the extension's own: photos and the weather). It is shown
	 * to people who hold its `requires`.
	 */
	'settings.display': Record<string, never>;
}

export type SlotName = keyof SlotProps;

interface SlotContributionOf<S extends SlotName> {
	slot: S;
	/** Unique, namespaced: `<extension>.<name>`. */
	id: string;
	/** Lower comes first. */
	order?: number;
	/** `dashboard.card` only: which band of Today the card belongs to (default `notes`). */
	band?: TodayBand;
	/**
	 * `dashboard.card` only: the block that shows or hides the card, when it is one of the
	 * extension's own `blocks` (the chores card is the rings of the chores block). Without it the
	 * card is a block of its own (or part of Needs you, in the `needs` band).
	 */
	block?: string;
	/**
	 * `dashboard.card` only: the card's rows are things to do (tasks). A style that keeps what
	 * needs doing apart from the day puts these with it (Broadsheet from 1280 px: the right
	 * column, under the glances); elsewhere they are rows like any other.
	 */
	todo?: boolean;
	/**
	 * `dashboard.card` only: how much room the card wants when it has content. `hero` is only
	 * honoured in the `day` band and only for one card (the lowest `order`).
	 */
	size?: 'hero' | 'wide' | 'compact';
	/**
	 * `dashboard.card`: the card's name in "What Today shows" (`<extension>:<key>`), where each
	 * person can hide it; without it the list uses the extension's name. `hintKey`: one line on
	 * what it shows. Cards of the `needs` band are part of Needs you and are not listed.
	 * `display.widget`: the widget's name where Settings → Devices says a display had no room for
	 * it. `display.page`: the page's name in a screen's list of pages and in the page's head.
	 */
	labelKey?: string;
	hintKey?: string;
	component: () => Promise<{ default: Component<SlotProps[S]> }>;
}

/** The slots a family display reads: what it may show depends on what it was granted. */
type DisplayRead =
	| 'today.atmosphere'
	| 'display.widget'
	| 'display.status'
	| 'display.ambient'
	| 'display.page';

/**
 * `requires`: the capability needed to show the contribution. A display shows a contribution only
 * when it holds it, and pairing a display offers the capabilities its slots and its Today (family
 * mode) name, so the slots a display reads always name one, and so does a card with a glance
 * (the only cards a display mounts). Contributions of extensions that are turned off are hidden
 * anyway.
 *
 * `glance` (`dashboard.card` only): the card has a glance (`form: 'glance'`): a number to read
 * from the door, or a shape the page draws. A style that shows the day at a glance puts these
 * with the family's numbers (Broadsheet: the family column) instead of with the day's rows.
 */
type Requirement<S extends SlotName> = S extends DisplayRead
	? { requires: string }
	: S extends 'dashboard.card'
		? { glance: true; requires: string } | { glance?: false; requires?: string }
		: { requires?: string };

/** A contribution to one slot; without an argument, to any slot (a union, so each keeps its props). */
export type SlotContribution<S extends SlotName = SlotName> = S extends SlotName
	? SlotContributionOf<S> & Requirement<S>
	: never;
