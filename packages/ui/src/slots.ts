import type { Component } from 'svelte';

/**
 * UI contribution points. Extensions contribute to slots from their `./web`
 * entry; the web app renders all contributions of a slot. Slot contracts are plain data plus a
 * lazy component loader, so they stay framework-neutral at the edges.
 */
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
	 */
	'display.widget': Record<string, never>;
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
	'display.ambient': { time: string; date: string };
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
	 * `dashboard.card` only: the card's name in "What Today shows" (`<extension>:<key>`), where
	 * each person can hide it; without it the list uses the extension's name. `hintKey`: one line
	 * on what it shows. Cards of the `needs` band are part of Needs you and are not listed.
	 */
	labelKey?: string;
	hintKey?: string;
	component: () => Promise<{ default: Component<SlotProps[S]> }>;
}

/** The slots a family display reads: what it may show depends on what it was granted. */
type DisplayRead = 'today.atmosphere' | 'display.widget' | 'display.status' | 'display.ambient';

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

/**
 * Where a page appears in navigation:
 * - `primary`: a phone tab / rail entry. The phone shows at most three primary pages between
 *   "Today" and "More"; extra primary pages overflow into "More" by `order`.
 * - `more`: listed in the "More" menu under its group.
 */
export type NavPlacement = 'primary' | 'more';

export interface NavContribution {
	/** Unique, namespaced: `<extension>.<name>`. */
	id: string;
	/** Path under the SPA, e.g. `/shopping`. */
	path: string;
	/** i18n key, namespaced by extension, e.g. `shopping:nav`. */
	labelKey: string;
	/** Icon component (Lucide icons via `@lucide/svelte`). */
	icon?: Component;
	placement: NavPlacement;
	/** Groups in the "More" menu, e.g. `family`, `home`, `money`. */
	group?: string;
	/** Lower comes first. */
	order?: number;
	/** Capability needed to see this entry. */
	requires?: string;
	/** Number badge, e.g. pending drafts; refreshed by the app. */
	badge?: () => Promise<number>;
	/**
	 * The page where things are shared with the family (Quick add): the app links to it from Today
	 * ("Needs you") and gives it the `n` key. One entry of all extensions at most.
	 */
	share?: boolean;
	/** A key that opens the page after `g` (`c`: `g c` opens the calendar). */
	shortcut?: string;
	/**
	 * For a page in the `settings` group: the part of the settings list it belongs to (default
	 * `system`).
	 */
	section?: SettingsSection;
	/**
	 * Pages that belong under this entry (Tasks and Shopping under Lists). The sidebar shows them
	 * as a group that folds; the phone tabs and the rail show only this entry, whose page leads to
	 * one of them. Each child's path lies under the entry's path.
	 */
	children?: NavChild[];
}

/** A page under a navigation entry (`NavContribution.children`). */
export type NavChild = Pick<
	NavContribution,
	'id' | 'path' | 'labelKey' | 'icon' | 'requires' | 'badge'
>;

/**
 * The groups of the settings list: what is about you, the family,
 * the AI, and the system. The list is the settings sidebar on wide windows and More on phones.
 */
export const SETTINGS_SECTIONS = ['you', 'family', 'ai', 'system'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export interface PresenterMember {
	id: string;
	displayName: string;
	color: string;
}

/** What a presenter needs from the app to render a draft. */
export interface PresenterContext {
	/** Translate a namespaced key, e.g. `calendar:draft_when`. */
	t(key: string, options?: Record<string, unknown>): string;
	members: readonly PresenterMember[];
	/** BCP 47 tag for numbers (the family's region format, not the language). */
	formatLocale: string;
	/** BCP 47 tag for dates and times: the UI language's words, the region's order (`useApp().dateLocale()`). */
	dateLocale: string;
	/** First day of the week, ISO: 1 = Monday … 7 = Sunday. */
	weekStart: number;
	hourCycle: 'h12' | 'h23';
	timeZone: string;
}

/** What the fields a waiting change touches hold now, keyed like its input; null when unknown. */
export type DraftBefore = Readonly<Record<string, unknown>> | null;

/**
 * A row's value for a change: "old → new" when the old value is known and differs, else the new
 * value alone.
 */
export const changedValue = (from: string | undefined, to: string): string =>
	from === undefined || from === to ? to : `${from} \u2192 ${to}`;

/**
 * A change row's `value` and `to`: the value reads "old → new" (`changedValue`), and `to` keeps the
 * new value alone, for places that say only what it will become.
 */
export const changed = (from: string | undefined, to: string): { value: string; to: string } => ({
	value: changedValue(from, to),
	to,
});

export interface DraftField {
	label: string;
	value: string;
	/**
	 * The new value alone, when `value` reads "old → new" (`changed`): what a mark beside the
	 * thing says it will become. `value` when left out.
	 */
	to?: string;
	/** Input path this field shows; matched against the draft's uncertain fields. */
	path?: string;
	/** Several input paths, when one row shows more than one field (date and times). */
	paths?: readonly string[];
}

/** Props of a presenter's editor component. */
export interface DraftEditorProps<I = unknown> {
	input: I;
	context: PresenterContext;
	/** Input paths the AI was unsure of, for the editor to mark. */
	uncertain?: readonly string[];
	onchange(input: I): void;
}

/**
 * How an extension shows drafts of one of its actions in Quick add.
 * Quick add knows no extension; it looks presenters up by action id.
 */
export interface DraftPresenter<I = unknown> {
	actionId: string;
	/** Short kind label, e.g. "Calendar". */
	kind(context: PresenterContext): string;
	icon?: Component;
	title(input: I, context: PresenterContext): string;
	/**
	 * The card's rows. `before` is what the fields a change touches hold now, keyed like the input
	 * (from the action's `currentValues`, waiting drafts only), for rows that read "old → new".
	 */
	fields(input: I, context: PresenterContext, before?: DraftBefore): DraftField[];
	/** Label of the approve button, e.g. "Add to calendar". */
	approveLabel?(context: PresenterContext): string;
	/** What a decided card says when the neutral "Done" is too vague, e.g. "Added to the calendar". */
	appliedLabel?(context: PresenterContext): string;
	editor?: () => Promise<{ default: Component<DraftEditorProps<I>> }>;
	/**
	 * When a draft of another action offers to become a draft of this one (a new event that is
	 * one already on the calendar): what is there already (`at` is when it is) and the button that
	 * chooses it, e.g. "Already on the calendar: Regional Gala · Sat 7 Nov 18:00" and "Move it to
	 * Sat 14 Nov 09:00 instead".
	 */
	instead?(
		input: I,
		at: { date: string; time?: string } | undefined,
		context: PresenterContext,
	): { there: string; action: string };
}

// biome-ignore lint/suspicious/noExplicitAny: registries hold presenters of different input types.
export type AnyDraftPresenter = DraftPresenter<any>;

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
export type TodayFacet = MemberCountsFacet | PhotoFacet | WeatherFacet | SetupHintFacet;

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

/** What an extension's `./web` entry exports. */
/** A model-backed feature that can be switched off on its own (Settings → AI). */
export interface AiFeatureContribution {
	/** The `feature` the extension names in model calls, e.g. `inbox.extract`. */
	id: string;
	labelKey: string;
	hintKey?: string;
}

/** Translatable texts: keys to strings, nested as in the JSON catalog files. */
export interface WebMessages {
	readonly [key: string]: string | WebMessages;
}

export interface WebExtension {
	/** The manifest's id: the namespace of its contributions and of its texts. */
	id: string;
	/**
	 * Its English texts (`src/messages/en.json`), registered under its id so keys read
	 * `<id>:<key>`. Other languages come from the server with the language's pack.
	 */
	messages?: WebMessages;
	/** Name and one-line description in Settings → Features (`<extension>:<key>`). */
	labelKey?: string;
	descriptionKey?: string;
	aiFeatures?: AiFeatureContribution[];
	slots?: SlotContribution[];
	/** Things that belong on the day's timeline on Today. */
	timeline?: TimelineContribution[];
	/** What Today shows in shapes of its own (counts per person, the photo, the weather, first steps). */
	today?: TodayFacet[];
	/** Blocks of Today this extension adds to "What Today shows". */
	blocks?: TodayBlockContribution[];
	nav?: NavContribution[];
	drafts?: AnyDraftPresenter[];
	/** Pages served under their path (matched by the app's catch-all route). */
	pages?: PageContribution[];
}

/** What the app passes to a page component: the values of the `:name` segments of its path. */
export interface PageProps {
	params: Record<string, string>;
}

export interface PageContribution {
	/** Unique, namespaced: `<extension>.<name>`. */
	id: string;
	/**
	 * Path under the SPA, e.g. `/calendar`. A segment written `:name` matches any single segment
	 * (`/vehicles/:id`) and arrives in the component's `params`. Exact paths win over patterns.
	 */
	path: string;
	/** A page without parameters may take no props at all. */
	component: () => Promise<{ default: Component | Component<PageProps> }>;
}

/**
 * An extension's `./web` entry. `manifest` is the `famos` field of its package.json, the same one
 * its server side declares, so both sides share one id.
 */
export function defineWebExtension(
	definition: Omit<WebExtension, 'id'> & { manifest: { id: string } },
): WebExtension {
	const { manifest, ...rest } = definition;
	const ext: WebExtension = { ...rest, id: manifest.id };
	const own = (id: string) => id.startsWith(`${ext.id}.`);
	for (const d of ext.drafts ?? []) {
		if (!own(d.actionId))
			throw new Error(`Draft presenter "${d.actionId}" must be namespaced as "${ext.id}.…"`);
	}
	for (const c of [
		...(ext.slots ?? []),
		...(ext.timeline ?? []),
		...(ext.today ?? []),
		...(ext.nav ?? []),
		...(ext.nav ?? []).flatMap((n) => n.children ?? []),
		...(ext.pages ?? []),
	]) {
		if (!own(c.id)) throw new Error(`Contribution "${c.id}" must be namespaced as "${ext.id}.…"`);
	}
	const blocks = new Set((ext.blocks ?? []).map((b) => b.id));
	for (const id of blocks) {
		if (id !== ext.id && !own(id))
			throw new Error(`Block "${id}" must be "${ext.id}" or namespaced as "${ext.id}.…"`);
	}
	for (const c of [...(ext.slots ?? []), ...(ext.today ?? [])]) {
		const block = 'block' in c ? c.block : undefined;
		if (block !== undefined && !blocks.has(block))
			throw new Error(`"${c.id}" names the block "${block}", which "${ext.id}" does not add`);
	}
	return ext;
}

export {
	askedBy,
	draftHeadline,
	draftKicker,
	namedInput,
	proposedByMember,
} from './draft-title.ts';

/**
 * What a pending draft's card says about the alternative it offers (a change of what is already
 * there): the presenter of the alternative's action words it; without one, the real title of what
 * it would change and a plain button. Undefined when there is no alternative.
 */
export function insteadOffer(draft: {
	instead: { actionId: string; input?: unknown; at?: { date: string; time?: string } } | null;
	/** The presenter of the alternative's action. */
	presenter: AnyDraftPresenter | undefined;
	context: PresenterContext;
	t: (key: string, options?: Record<string, unknown>) => string;
}): { there: string; action: string } | undefined {
	const { instead, presenter } = draft;
	if (!instead) return undefined;
	if (presenter?.instead) return presenter.instead(instead.input, instead.at, draft.context);
	const label =
		typeof instead.input === 'object' && instead.input !== null && 'label' in instead.input
			? instead.input.label
			: undefined;
	return {
		there:
			typeof label === 'string' && label.trim()
				? draft.t('app:draft_instead_there', { name: label.trim() })
				: draft.t('app:draft_instead_there_unnamed'),
		action: draft.t('app:draft_instead'),
	};
}

/**
 * What a mark beside a thing says while the member's change to it waits for approval: "Waiting for
 * approval", followed by what the change makes of it, from the presenter of its action ("Due: Tue
 * 20 Oct"). Each row gives its new value alone (`DraftField.to`): the thing on screen already shows
 * what it holds now. Without a presenter, or rows, the plain words.
 */
export function awaitingText(change: {
	input: unknown;
	before: DraftBefore;
	presenter: AnyDraftPresenter | undefined;
	context: PresenterContext;
}): string {
	const { context, presenter } = change;
	const waiting = context.t('app:draft_waiting');
	if (!presenter) return waiting;
	let fields: DraftField[];
	try {
		fields = presenter.fields(change.input, context, change.before ?? undefined);
	} catch {
		// An input stored by another version may not fit today's presenter: say only that it waits.
		return waiting;
	}
	const parts = fields
		.map((f) => ({ label: f.label, value: (f.to ?? f.value).trim() }))
		.filter((f) => f.value !== '')
		.map((f) => context.t('app:draft_waiting_field', f));
	return parts.length === 0
		? waiting
		: context.t('app:draft_waiting_change', { change: parts.join(', ') });
}
