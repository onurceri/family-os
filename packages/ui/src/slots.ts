import type { Component } from 'svelte';

/**
 * UI contribution points. Extensions contribute to slots from their `./web`
 * entry; the web app renders all contributions of a slot. Slot contracts are plain data plus a
 * lazy component loader, so they stay framework-neutral at the edges.
 */
/**
 * "What usually needs doing" for a kind of record, offered by its domain extension to the
 * `record.section` slot. Structurally the same as `ObligationPreset` in the records contract.
 */
export interface RecordPreset {
	id: string;
	/** Namespaced translation key of the domain (`vehicles:preset_inspection`). */
	titleKey: string;
	every?: { months?: number; years?: number };
	leadDays?: number;
	labelKey?: string;
}

/** A record Quick add can file papers into ("Add to …"). */
export interface FileTarget {
	recordId: string;
	recordKind: string;
	/** What the person sees ("Golf", "Luna"). */
	name: string;
}

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

export interface SlotProps {
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
	 * A section of a record's page. The domain extension owns the page and renders this
	 * slot with `<Slot name="record.section" props={…} />`; `records` contributes the obligations
	 * and the papers, other extensions can add their own. `recordName` and `recordUrl` let a
	 * section keep lists that span records readable.
	 */
	'record.section': {
		recordId: string;
		recordKind: string;
		recordName: string;
		recordUrl?: string;
		/** Capability whose holders are reminded about new obligations when nobody is assigned. */
		audience?: string;
		presets?: readonly RecordPreset[];
	};
	/**
	 * Records a person can file Quick add papers into, contributed by domain extensions. Each
	 * contribution shows its own records as choices (and nothing when it has none); `selected` is
	 * the current choice across all contributions. With no contribution Quick add hides "Add to…".
	 */
	'inbox.fileTarget': { selected: FileTarget | null; onselect(target: FileTarget | null): void };
	/**
	 * An optional step of first-run setup, shown after the founder's account exists and they are
	 * signed in (they hold every capability). It must never block setup: it offers Skip and calls
	 * `done` when it is finished or skipped.
	 */
	'setup.step': { done: () => void };
	/**
	 * Sections of Settings, Devices & displays, below the displays: what family displays show
	 * (photos, weather, timing). The contribution renders `Section`s of its own and loads its own
	 * data; it is shown to people who hold its `requires`.
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
	/**
	 * Capability needed to show this contribution (`display.widget`, `display.status`: the display
	 * must hold it). Pairing a display offers the capabilities that `display.widget`,
	 * `display.status` and `display.ambient` contributions name here, besides those of the
	 * display's Today (family mode), so declare it for every contribution that reads protected data.
	 * Contributions of extensions that are turned off are hidden anyway.
	 */
	requires?: string;
	/** `dashboard.card` only: which band of Today the card belongs to (default `notes`). */
	band?: TodayBand;
	/**
	 * `dashboard.card` only: the card has a glance (`form: 'glance'`): a number to read from the
	 * door, or a shape the page draws. A style that shows the day at a glance puts these with the
	 * family's numbers (Broadsheet: the family column) instead of with the day's rows.
	 */
	glance?: boolean;
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

/** A contribution to one slot; without an argument, to any slot (a union, so each keeps its props). */
export type SlotContribution<S extends SlotName = SlotName> = S extends SlotName
	? SlotContributionOf<S>
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
 * The groups of the settings list (design system v2 section 7.2): what is about you, the family,
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
	/** BCP 47 tag for dates, times and numbers (the family's region formats, not the language). */
	formatLocale: string;
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

export interface DraftField {
	label: string;
	value: string;
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
	hourCycle(): 'h12' | 'h23';
	timeZone(): string;
	members(): readonly PresenterMember[];
}

export interface TimelineContribution {
	/** Unique, namespaced: `<extension>.<name>`. */
	id: string;
	requires?: string;
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

/** What an extension's `./web` entry exports. */
/** A model-backed feature that can be switched off on its own (Settings → AI). */
export interface AiFeatureContribution {
	/** The `feature` the extension names in model calls, e.g. `inbox.extract`. */
	id: string;
	labelKey: string;
	hintKey?: string;
}

export interface WebExtension {
	id: string;
	/** Name and one-line description in Settings → Features (`<extension>:<key>`). */
	labelKey?: string;
	descriptionKey?: string;
	aiFeatures?: AiFeatureContribution[];
	slots?: SlotContribution[];
	/** Things that belong on the day's timeline on Today. */
	timeline?: TimelineContribution[];
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

export function defineWebExtension(ext: WebExtension): WebExtension {
	for (const d of ext.drafts ?? []) {
		// The assistant also presents the personal core actions it proposes (a memory, a question
		// to a person): core has no web entry of its own.
		const ownsCoreAction = ext.id === 'assistant' && d.actionId.startsWith('core.');
		if (!ownsCoreAction && !d.actionId.startsWith(`${ext.id}.`))
			throw new Error(`Draft presenter "${d.actionId}" must be namespaced as "${ext.id}.…"`);
	}
	for (const c of [
		...(ext.slots ?? []),
		...(ext.timeline ?? []),
		...(ext.nav ?? []),
		...(ext.nav ?? []).flatMap((n) => n.children ?? []),
		...(ext.pages ?? []),
	]) {
		if (!c.id.startsWith(`${ext.id}.`))
			throw new Error(`Contribution "${c.id}" must be namespaced as "${ext.id}.…"`);
	}
	return ext;
}

export { askedBy, draftHeadline, draftKicker, proposedByMember } from './draft-title.ts';

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
