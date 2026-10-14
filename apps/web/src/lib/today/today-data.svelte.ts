import { addDays, epochOf, todayIn } from '@famos/time';
import type { AppContext } from '@famos/ui/app';
import {
	type ChoreCount,
	type ChoreRing,
	choresLeft,
	type FamilyStatus,
	firstName,
	formatClock,
	formatPhotoMonth,
	type MemberDays,
	memberDays,
	type NextUpMode,
	nextUp,
	statusOf,
	statusText,
	type TodayBlockOptions,
	type TodayFormat,
	withShortNames,
} from '@famos/ui/famos';
import type {
	DayItem,
	SlotContribution,
	TimelineContribution,
	TimelineItem,
	TodayBand,
	TodayFacet,
	TodayReport,
} from '@famos/ui/slots';
import { untrack } from 'svelte';
import { api } from '#lib/api.js';
import { facetsOf, hasDay, type Viewer } from '#lib/contributions.js';
import { contributions, enabledOnly } from '#lib/extensions.js';
import type { Step } from '#lib/FirstSteps.svelte';
import { family } from '#lib/family.svelte.js';
import { t, tDynamic } from '#lib/i18n.svelte.js';
import { session } from '#lib/session.svelte.js';
import {
	aheadWindow,
	composeQuietLine,
	composeSentence,
	doneTitles,
	emphasisRuns,
	isEvening,
	isLightDay,
	lastTonight,
	mergeTimeline,
	nextDays,
	orderCards,
	partOfDay,
	quietPhrases,
	showCaptureBox,
} from '#lib/today.js';
import { type FacetWords, type TodayWords, todayWords } from '#lib/today-words.js';
import { blockOfCard, everythingHidden, shows, type TodayBlock, todayBlocks } from './blocks.js';

/**
 * Everything Today shows, loaded and settled in one place. Every style's
 * composition (Broadsheet, Wall, Lanes) takes one `TodayData` and only arranges it: the day's
 * timeline and the look-ahead, the cards and what they report, the facets extensions provide
 * (counts per person, the photo of the day, the weather's hours, the first steps of a new
 * family), whose next thing the hero shows, and when the page is settled (composed once). It
 * names no extension: everything comes from `contributions`. Create it while a component
 * initialises: it owns effects.
 *
 * **Family mode** (a family display): no person. It reads only what
 * the display holds (`app.can`: the display's view capabilities) through routes a display may
 * call, mounts no card a person acts on (only those with a glance, such as shopping as a number),
 * never loads the first steps or the AI row, and keeps the hero on the family's next thing.
 * Without the `requires` of any timeline contribution there is no day (no hero, no day by
 * person, no evening or quiet note).
 * With names off there is no per-person structure: the day is one column of everything, chores
 * one total, and no item carries its people. Nothing in it is a link.
 */

export type Card = SlotContribution<'dashboard.card'>;
type Atmosphere = SlotContribution<'today.atmosphere'>;
export interface PhotoOfTheDay {
	src: string;
	label: string;
}

/** How long the page waits for every first report before it shows what it has. */
const SETTLE_CAP_MS = 1200;
/** The family's next thing is the default; the person's choice is kept server-side. */
const DEFAULT_MODE: NextUpMode = 'family';

const bandOf = (c: Card): TodayBand => c.band ?? 'notes';

/** What Today needs of a member (a preview's made-up people and a display's have only this). */
type FamilyMember = Pick<(typeof family.members)[number], 'id' | 'displayName' | 'color'>;
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

/**
 * What a display may be granted for Today in family mode, offered when pairing besides what the
 * `display.*` slots name: what the timelines (the day), the facets a display shows (counts per
 * person, the photo, the weather's hours), the weather and the cards with a glance need.
 */
export function familyModeCapabilities(): string[] {
	return [
		...new Set([
			...contributions.timelines.map((c) => c.requires),
			...contributions.facets.filter((f) => f.kind !== 'setupHint').map((f) => f.requires),
			...contributions.slots.flatMap((c) =>
				c.slot === 'today.atmosphere' || (c.slot === 'dashboard.card' && c.glance === true)
					? [c.requires]
					: [],
			),
		]),
	];
}

/** An extension's name key (Settings → Features), for a card without a `labelKey` of its own. */
const extensionLabel = (id: string): string | undefined => contributions.extension(id)?.labelKey;

/** The first facet of a kind from an extension that is turned on, whoever views. */
const providedFacet = <K extends TodayFacet['kind']>(kind: K, off: readonly string[]) =>
	facetsOf(contributions.facets, kind, { can: () => true, disabledExtensions: off })[0];

/** What the app's own blocks need (the weather, the photo), from extensions that are turned on. */
const providers = (off: readonly string[]) => ({
	weather:
		providedFacet('weather', off) !== undefined ||
		enabledOnly(
			contributions.slots.filter((c) => c.slot === 'today.atmosphere'),
			off,
		).length > 0,
	photo: providedFacet('photo', off) !== undefined,
});

/**
 * The blocks "What Today shows" offers to a viewer: a person (the cards they may see), the
 * family's default (every card that is on: people differ in what they may see) or a display
 * (`familyMode`: only cards with a glance, no person-only blocks).
 */
export function availableTodayBlocks(viewer: {
	familyMode?: boolean;
	can?: (capability: string) => boolean;
	disabledExtensions: readonly string[];
}): TodayBlock[] {
	const cards = enabledOnly(
		contributions.slots.filter(
			(c): c is Card =>
				c.slot === 'dashboard.card' &&
				(!viewer.familyMode || c.glance === true) &&
				(!viewer.can || !c.requires || viewer.can(c.requires)),
		),
		viewer.disabledExtensions,
	).toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0));
	return todayBlocks(cards, {
		familyMode: viewer.familyMode ?? false,
		added: enabledOnly(contributions.blocks, viewer.disabledExtensions),
		provided: providers(viewer.disabledExtensions),
		extensionLabel,
	});
}

export class TodayData {
	readonly app: AppContext;
	/** Set for a preview: everything comes from it and nothing is loaded. */
	#sample: TodaySample | null = null;
	/** Set for a family display. */
	#familyMode: TodayFamilyMode | null = null;
	#hiddenOf: (() => readonly string[]) | null = null;
	#hiddenKnown: (() => boolean) | null = null;
	#hide: ((block: string) => void) | null = null;

	/* ───────────── who views ───────────── */

	/** A family display: no person, no actions, only what the display holds. */
	get familyMode(): boolean {
		return this.#familyMode !== null;
	}
	/** Whether people appear: their columns, lanes, rows, rings, names and colours. */
	get showNames(): boolean {
		return this.#familyMode?.showNames ?? true;
	}
	/** Whoever views holds a capability (the person, or the display in family mode). */
	can = (capability: string): boolean =>
		this.#familyMode ? this.app.can(capability) : session.can(capability);
	readonly disabledExtensions = $derived<readonly string[]>(
		this.#familyMode ? this.#familyMode.disabledExtensions() : session.disabledExtensions,
	);
	/** Whoever views is known: a signed-in person; a display is known before its page makes this. */
	readonly ready = $derived(this.#familyMode !== null || session.status === 'ready');
	/** Changes when someone else views: what is loaded is read again. */
	readonly #viewer = $derived(this.#familyMode ? 'display' : (session.me?.id ?? ''));
	readonly #viewing = $derived<Viewer>({
		can: this.can,
		disabledExtensions: this.disabledExtensions,
	});
	/**
	 * The day (the hero, the day by person, the evening, the quiet day): a display needs what a
	 * timeline contribution requires.
	 */
	readonly showsDay = $derived(!this.#familyMode || hasDay(contributions.timelines, this.#viewing));
	#allowed = (c: { requires?: string | undefined }): boolean => !c.requires || this.can(c.requires);

	/* ───────────── time ───────────── */

	now = $state(Date.now());
	// (`$derived.by`: `app` is set in the constructor, after these fields; they run later.)
	readonly timeZone = $derived.by(() => (this.#familyMode ? this.app.timeZone() : family.timeZone));
	readonly today = $derived(todayIn(this.timeZone, this.now));
	readonly tomorrow = $derived(addDays(this.today, 1));
	readonly format = $derived.by<TodayFormat>(() =>
		this.#familyMode
			? {
					formatLocale: this.app.formatLocale(),
					hourCycle: this.app.hourCycle(),
					timeZone: this.app.timeZone(),
				}
			: {
					formatLocale: family.formatLocale,
					hourCycle: family.hourCycle,
					timeZone: family.timeZone,
				},
	);
	/** The words of the compositions: the app's, and those of the facets and blocks shown. */
	readonly words = $derived.by<TodayWords>(() => {
		const counts = this.memberCounts;
		const meals = this.mealsBlock;
		const extra: FacetWords = {
			...(counts && {
				counts: {
					title: tDynamic(counts.titleKey),
					label: tDynamic(counts.labelKey),
					ring: (name, done, total) => tDynamic(counts.ringKey, { name, done, total }),
					left: (count) => tDynamic(counts.leftKey, { count }),
				},
			}),
			...(meals && { meals: tDynamic(meals.titleKey ?? meals.labelKey) }),
		};
		return todayWords(t, extra);
	});
	/** The family; `shortName` is what a column, lane or ring shows (the first name). */
	readonly members = $derived.by<readonly (FamilyMember & { shortName: string })[]>(() =>
		withShortNames(
			this.#sample?.members ??
				(this.#familyMode ? (this.showNames ? this.app.members() : []) : family.members),
		),
	);
	readonly me = $derived<TodayMe | null>(
		this.#sample ? this.#sample.me : this.#familyMode ? null : session.me,
	);

	/* ───────────── the facets extensions provide ───────────── */

	/**
	 * The first facet of a kind this viewer may see. A preview takes the first of an extension
	 * that is turned on (it reads nothing; its made-up day still needs the words).
	 */
	#facet<K extends TodayFacet['kind']>(kind: K) {
		return this.#sample
			? providedFacet(kind, this.disabledExtensions)
			: facetsOf(contributions.facets, kind, this.#viewing)[0];
	}
	/** Things of the day counted per person (chores): rings, bars, "2 left". */
	readonly memberCounts = $derived(this.#facet('perMember'));
	/** The block that shows or hides the counts per person. */
	readonly countsBlock = $derived(this.memberCounts?.block ?? '');
	/** The page the counts open (none on a display: nothing there is a link). */
	readonly countsHref = $derived.by(() => {
		const href = this.memberCounts?.href;
		return href && this.app.isAppPath(href) ? href : undefined;
	});
	readonly #photoSource = $derived(this.#sample ? undefined : this.#facet('photo'));
	/** The steps extensions add to the first steps of a new family, in `order`. */
	readonly #setupHints = $derived(
		this.#familyMode || this.#sample
			? []
			: facetsOf(contributions.facets, 'setupHint', this.#viewing).toSorted(
					(a, b) => (a.order ?? 0) - (b.order ?? 0),
				),
	);
	/** The blocks extensions add, of those that are turned on. */
	readonly #addedBlocks = $derived(enabledOnly(contributions.blocks, this.disabledExtensions));
	/** The block that is the day's meals as a list of their own. */
	readonly mealsBlock = $derived(this.#addedBlocks.find((b) => b.items === 'meal'));
	/** The page that shows the whole day, which the day and the next days link to. */
	readonly dayHref = $derived(
		contributions.timelines
			.map((c) => c.page)
			.find((page): page is string => page !== undefined && this.app.isAppPath(page)),
	);

	/* ───────────── what this Today shows ───────────── */

	/** The blocks hidden here (show or hide only: the style still composes what is left). */
	readonly hidden = $derived<ReadonlySet<string>>(new Set(this.#hiddenOf?.() ?? []));
	/** Whether a block shows (a built-in id, or a card's contribution id; unknown ids show). */
	shows = (block: string): boolean => shows(this.hidden, block);
	/** The weather's next hours, for a style that draws them itself (Lanes), when shown here. */
	readonly weatherSource = $derived(
		this.shows('weather') ? facetsOf(contributions.facets, 'weather', this.#viewing)[0] : undefined,
	);

	/** The cards this viewer may see, hidden or not (what "What Today shows" lists). */
	readonly availableCards = $derived(
		(this.#sample
			? []
			: enabledOnly(
					contributions.slots.filter(
						(c): c is Card =>
							c.slot === 'dashboard.card' &&
							// A display mounts only what reads at a glance: nothing to act on.
							(!this.#familyMode || c.glance === true) &&
							this.#allowed(c),
					),
					this.disabledExtensions,
				)
		).toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0)),
	);
	/** The blocks this viewer could see. */
	readonly blocks = $derived<TodayBlock[]>(
		todayBlocks(this.availableCards, {
			familyMode: this.familyMode,
			added: this.#addedBlocks,
			provided: providers(this.disabledExtensions),
			extensionLabel,
		}),
	);
	/** Every block is hidden: Today says so and offers the way back (never on a preview). */
	readonly nothingShown = $derived(!this.#sample && everythingHidden(this.blocks, this.hidden));
	/** A block's name, as "What Today shows" lists it. */
	blockName = (id: string): string => {
		const block = this.blocks.find((b) => b.id === id);
		return block ? tDynamic(block.labelKey) : id;
	};
	/**
	 * The `...` menu of a block's label ("Hide from Today"), for `TodayBlock`. None on a display
	 * or a preview, which have no person to choose.
	 */
	menuFor = (id: string): TodayBlockOptions | undefined => {
		const hide = this.#hide;
		if (!hide || this.#sample || this.#familyMode) return undefined;
		const name = this.blockName(id);
		return {
			name,
			menuLabel: t('block_menu', { name }),
			hideLabel: t('block_hide'),
			cancelLabel: t('cancel'),
			hide: () => hide(id),
		};
	};
	/** The menu of the block a card belongs to (its own, Needs you, or the block it is tied to). */
	menuForCard = (card: Card): TodayBlockOptions | undefined => this.menuFor(blockOfCard(card));

	/** The cards that show: a hidden one is not mounted at all (and not waited for). */
	readonly allCards = $derived(this.availableCards.filter((c) => this.shows(blockOfCard(c))));
	reports = $state<Record<string, TodayReport>>({});
	readonly #reporters = new Map<string, (r: TodayReport) => void>();
	/** Every card has sent its first report (one that never reports is covered by the cap). */
	readonly reported = $derived(this.allCards.every((c) => this.reports[c.id]));

	/** The weather (`today.atmosphere`): it says whether it shows something before the page shows. */
	readonly atmosphere = $derived(
		this.#sample
			? []
			: enabledOnly(
					contributions.slots.filter(
						(c): c is Atmosphere =>
							c.slot === 'today.atmosphere' && this.shows('weather') && this.#allowed(c),
					),
					this.disabledExtensions,
				),
	);
	atmosphereShown = $state<Record<string, boolean>>({});
	readonly #atmosphereReporters = new Map<string, (r: { shown: boolean }) => void>();
	readonly atmosphereReported = $derived(
		this.atmosphere.every((c) => this.atmosphereShown[c.id] !== undefined),
	);
	readonly hasWeather = $derived(this.atmosphere.some((c) => this.atmosphereShown[c.id]));

	/* ───────────── the day's timeline, and the next days ───────────── */

	readonly timelines = $derived(
		this.#sample || !this.showsDay
			? []
			: enabledOnly(contributions.timelines, this.disabledExtensions).filter((c) =>
					this.#allowed(c),
				),
	);
	todayItems = $state<TimelineItem[]>([]);
	tomorrowItems = $state<TimelineItem[]>([]);
	aheadLists = $state<(readonly DayItem[])[]>([]);
	timelineLoaded = $state(false);
	aheadLoaded = $state(false);

	readonly evening = $derived(
		this.showsDay &&
			this.timelineLoaded &&
			isEvening(this.now, this.todayItems, this.today, this.timeZone),
	);
	/** The day the page is about: today, or tomorrow in the evening. */
	readonly dayItems = $derived(this.evening ? this.tomorrowItems : this.todayItems);
	readonly aheadRange = $derived(aheadWindow(this.today, this.evening));
	readonly nextDaysItems = $derived(
		nextDays(
			this.aheadLists.map((list) =>
				list.filter((item) => item.day >= this.aheadRange.from && item.day <= this.aheadRange.to),
			),
		),
	);
	readonly showNext = $derived(
		this.showsDay &&
			this.shows('nextDays') &&
			this.timelineLoaded &&
			isLightDay(this.dayItems.length) &&
			this.nextDaysItems.length > 0,
	);

	/* ───────────── counts per person and the photo of the day ───────────── */

	/** Today's counts per person (`null`: anyone), from the `perMember` facet. */
	chores = $state<ChoreCount[]>([]);
	choresLoaded = $state(false);
	photo = $state<{ src: string; month: string } | null>(null);
	photoLoaded = $state(false);

	/* ───────────── a new family, and AI not connected ───────────── */

	aiMissing = $state(false);
	/** The answers of the extensions' first steps, by id: done or not. */
	hintsDone = $state<Record<string, boolean>>({});
	setupLoaded = $state(false);
	stepsHidden = $state(false);
	aiDismissed = $state(false);

	/* ───────────── whose next thing ───────────── */

	/** Chosen on this page and not yet confirmed by the server. */
	#mode = $state<NextUpMode | null>(null);

	/* ───────────── settling ───────────── */

	settled = $state(false);

	constructor(app: AppContext, options: TodayOptions = {}) {
		this.app = app;
		const { sample, familyMode } = options;
		this.#sample = sample ?? null;
		this.#familyMode = familyMode ?? null;
		this.#hiddenOf = options.hidden ?? null;
		this.#hiddenKnown = options.hiddenKnown ?? null;
		this.#hide = options.hide ?? null;
		if (sample) {
			// A preview: the day is given, nothing loads and nothing changes.
			this.now = sample.now;
			this.todayItems = sample.todayItems;
			this.tomorrowItems = sample.tomorrowItems;
			this.chores = sample.chores;
			this.timelineLoaded = this.aheadLoaded = this.choresLoaded = true;
			this.photoLoaded = this.setupLoaded = this.settled = true;
			return;
		}

		$effect(() => {
			const timer = setInterval(() => (this.now = Date.now()), 15_000);
			return () => clearInterval(timer);
		});

		// The day and tomorrow, again whenever a contribution's events arrive. The loads run
		// untracked: what a contribution reads while it starts is not a reason to read again.
		$effect(() => {
			const day = this.today;
			const next = this.tomorrow;
			const sources = this.timelines;
			void app.offline();
			untrack(() => void this.#loadTimeline(day, next, sources));
			const offs = sources.flatMap((c) =>
				(c.invalidateOn ?? []).map((prefix) =>
					app.onEvent(prefix, () => void this.#loadTimeline(day, next, sources)),
				),
			);
			return () => {
				for (const off of offs) off();
			};
		});

		// The look-ahead, started with the day: whether it is evening is not known yet, so it asks
		// for both possible windows at once and `aheadRange` picks the part that applies.
		$effect(() => {
			const window = { from: addDays(this.today, 1), to: addDays(this.today, 7) };
			const sources = this.timelines;
			void app.offline();
			untrack(() => void this.#loadAhead(window, sources));
			const offs = sources.flatMap((c) =>
				(c.invalidateOn ?? []).map((prefix) =>
					app.onEvent(prefix, () => void this.#loadAhead(window, sources)),
				),
			);
			return () => {
				for (const off of offs) off();
			};
		});

		$effect(() => {
			void this.#viewer;
			const source = this.memberCounts;
			void this.today;
			void app.offline();
			untrack(() => void this.#loadChores());
			return onEvents(app, source?.invalidateOn, () => void this.#loadChores());
		});

		$effect(() => {
			void this.#viewer;
			const source = this.#photoSource;
			void this.today;
			untrack(() => void this.#loadPhoto());
			return onEvents(app, source?.invalidateOn, () => void this.#loadPhoto());
		});

		if (familyMode) {
			// A display has no first steps and no AI row: nobody there could act on them.
			this.setupLoaded = true;
		} else {
			$effect(() => {
				void session.me?.id;
				this.stepsHidden = this.#remembered('steps');
				this.aiDismissed = this.#remembered('ai');
			});

			// Once the family is known (whether it is one person decides what to ask), and again
			// only when that answer, the person or the day changes.
			$effect(() => {
				if (!family.loaded) return;
				void session.me?.id;
				void this.#alone;
				void this.today;
				const hints = this.#setupHints;
				untrack(() => void this.#loadSetup());
				return onEvents(
					app,
					hints.flatMap((h) => h.invalidateOn ?? []),
					() => void this.#loadSetup(),
				);
			});
		}

		// Today composes once: the head shows at once, the body when everything is in (or the cap).
		// Once settled it stays settled: live updates change the composition in place.
		$effect(() => {
			if (
				this.ready &&
				(familyMode !== undefined || family.loaded) &&
				(this.#hiddenKnown?.() ?? true) &&
				this.reported &&
				this.atmosphereReported &&
				this.timelineLoaded &&
				this.aheadLoaded &&
				this.setupLoaded &&
				this.choresLoaded &&
				this.photoLoaded
			)
				this.settled = true;
		});
		$effect(() => {
			// The cap counts from when the person is known: before that nothing can load.
			if (!this.ready) return;
			const timer = setTimeout(() => (this.settled = true), SETTLE_CAP_MS);
			return () => clearTimeout(timer);
		});
	}

	/* ───────────── loading ───────────── */

	/** A family of one (so far): the first steps may apply. */
	readonly #alone = $derived(family.members.length <= 1);

	async #loadDay(day: string, sources: readonly TimelineContribution[]) {
		const lists = await Promise.all(
			sources.map((c) => c.load(day, this.app).catch(() => [] as readonly TimelineItem[])),
		);
		return mergeTimeline(lists);
	}

	async #loadTimeline(day: string, next: string, sources: readonly TimelineContribution[]) {
		const [a, b] = await Promise.all([this.#loadDay(day, sources), this.#loadDay(next, sources)]);
		this.todayItems = this.#forFamily(a);
		this.tomorrowItems = this.#forFamily(b);
		this.timelineLoaded = true;
	}

	async #loadAhead(window: { from: string; to: string }, sources: readonly TimelineContribution[]) {
		const lists = await Promise.all(
			sources.map((c) =>
				c.loadAhead
					? c.loadAhead(window.from, window.to, this.app).catch(() => [] as readonly DayItem[])
					: Promise.resolve([] as readonly DayItem[]),
			),
		);
		this.aheadLists = lists.map((list) => this.#forFamily(list));
		this.aheadLoaded = true;
	}

	/**
	 * Family mode: nothing on a display is a link (it only looks), and with names off no item
	 * keeps its people or the subtitle that may name them.
	 */
	#forFamily<T extends TimelineItem>(items: readonly T[]): T[] {
		if (!this.#familyMode) return [...items];
		if (this.showNames) return items.map((item) => ({ ...item, href: '' }));
		return items.map(
			({ subtitle: _named, ...item }) => ({ ...item, href: '', members: [] }) as unknown as T,
		);
	}

	/**
	 * Reads the day, the look-ahead, the counts and the photo again (a display does it now and
	 * then in case it missed a live update). The composition stays as it is while they arrive.
	 */
	reload() {
		if (this.#sample) return;
		const sources = this.timelines;
		void this.#loadTimeline(this.today, this.tomorrow, sources);
		void this.#loadAhead({ from: addDays(this.today, 1), to: addDays(this.today, 7) }, sources);
		void this.#loadChores();
		void this.#loadPhoto();
	}

	async #loadChores() {
		try {
			const source = this.memberCounts;
			if (!source) {
				this.chores = [];
				return;
			}
			this.chores = [...(await source.load(this.app))];
		} catch {
			// Keep what is on screen.
		} finally {
			this.choresLoaded = true;
		}
	}

	async #loadPhoto() {
		try {
			const source = this.#photoSource;
			if (!source) {
				this.photo = null;
				return;
			}
			this.photo = await source.load(this.app);
		} catch {
			// Keep what is on screen.
		} finally {
			this.photoLoaded = true;
		}
	}

	async #loadSetup() {
		const jobs: Promise<unknown>[] = [];
		const app = this.app;
		if (session.can('core.ai.manage'))
			jobs.push(
				api.GET('/api/v1/ai/settings').then((res) => {
					const roles = res.data?.roles;
					this.aiMissing = Boolean(roles) && !roles?.fast && !roles?.vision && !roles?.smart;
				}),
			);
		// A step that says whether the family is new is asked only while it has one person.
		for (const hint of this.#setupHints.filter((h) => !h.fresh || this.#alone))
			jobs.push(
				hint
					.load(app)
					.catch(() => true)
					.then((done) => (this.hintsDone[hint.id] = done)),
			);
		await Promise.allSettled(jobs);
		this.setupLoaded = true;
	}

	/* ───────────── what the cards report ───────────── */

	/** The callback a card reports through (one per card, so its props stay the same). */
	reporter(id: string): (r: TodayReport) => void {
		let fn = this.#reporters.get(id);
		if (!fn) {
			fn = (r) => {
				if (JSON.stringify(this.reports[id]) !== JSON.stringify(r)) this.reports[id] = r;
			};
			this.#reporters.set(id, fn);
		}
		return fn;
	}

	atmosphereReporter(id: string): (r: { shown: boolean }) => void {
		let fn = this.#atmosphereReporters.get(id);
		if (!fn) {
			fn = (r) => {
				if (this.atmosphereShown[id] !== r.shown) this.atmosphereShown[id] = r.shown;
			};
			this.#atmosphereReporters.set(id, fn);
		}
		return fn;
	}

	hasContent = (c: Card): boolean => (this.reports[c.id]?.count ?? 0) > 0;
	#countOf = (cards: readonly Card[]) =>
		cards.reduce((sum, c) => sum + (this.reports[c.id]?.count ?? 0), 0);
	#inBand = (band: TodayBand) =>
		orderCards(
			this.allCards.filter((c) => bandOf(c) === band),
			this.reports,
		);

	readonly needsCards = $derived(this.#inBand('needs'));
	readonly dayCards = $derived(this.#inBand('day'));
	/** Notes cards in a fixed order (the keyed blocks never move an element back). */
	readonly notesCards = $derived(this.allCards.filter((c) => bandOf(c) === 'notes'));
	/** Notes cards that have a glance (shopping as a number, chores as rings). */
	readonly glanceCards = $derived(this.notesCards.filter((c) => c.glance));
	/** Notes cards that are rows (the board's papers, tasks). */
	readonly rowCards = $derived(this.notesCards.filter((c) => !c.glance));
	/** Rows that are things to do (tasks): a style may keep them with what needs doing. */
	readonly todoCards = $derived(this.rowCards.filter((c) => c.todo));
	readonly aheadCards = $derived(this.#inBand('ahead'));
	readonly footCards = $derived(this.#inBand('foot'));

	/** A card's props: `line` when it has nothing (it renders nothing; it still reports). */
	propsFor(c: Card, size: 'wide' | 'half', form: 'rows' | 'glance' = 'rows') {
		return {
			band: bandOf(c),
			size: this.hasContent(c) ? size : ('line' as const),
			form,
			report: this.reporter(c.id),
		};
	}

	/* ───────────── a new family, and AI not connected ───────────── */

	/**
	 * A new family: one person, and none of the steps that say so is done yet (with no such step
	 * nothing says the family is new).
	 */
	readonly fresh = $derived.by(() => {
		const telling = this.#setupHints.filter((h) => h.fresh);
		return (
			this.setupLoaded &&
			family.members.length <= 1 &&
			telling.length > 0 &&
			telling.every((h) => this.hintsDone[h.id] === false)
		);
	});
	readonly steps = $derived.by((): Step[] => {
		const list: Step[] = [
			{ id: 'account', title: t('home_step_account'), text: t('home_step_done'), done: true },
		];
		if (session.can('core.members.manage'))
			list.push({
				id: 'people',
				title: t('home_step_people'),
				text: t('home_step_people_text'),
				done: family.members.length > 1,
				href: '/settings/members',
				action: t('home_step_people_action'),
			});
		// The extensions' steps, each once its answer is in.
		for (const hint of this.#setupHints) {
			const done = this.hintsDone[hint.id];
			if (done === undefined) continue;
			list.push({
				id: hint.id,
				title: tDynamic(hint.titleKey),
				text: tDynamic(hint.textKey),
				done,
				href: hint.href,
				action: tDynamic(hint.actionKey),
			});
		}
		if (session.can('core.ai.manage'))
			list.push({
				id: 'ai',
				title: t('home_step_ai'),
				text: t('home_step_ai_text'),
				done: !this.aiMissing,
				href: '/settings/ai',
				action: t('home_step_ai_action'),
			});
		return list;
	});
	readonly showSteps = $derived(
		this.fresh && !this.stepsHidden && this.steps.some((s) => !s.done && s.href),
	);
	readonly showAiRow = $derived(
		!this.fresh && this.setupLoaded && this.aiMissing && !this.aiDismissed && this.shows('needs'),
	);

	hideSteps() {
		this.#remember('steps');
		this.stepsHidden = true;
	}

	dismissAi() {
		this.#remember('ai');
		this.aiDismissed = true;
	}

	#storageKey = (what: string) => `famos.today.${what}.${session.me?.id ?? ''}`;
	#remembered(what: string): boolean {
		try {
			return localStorage.getItem(this.#storageKey(what)) === '1';
		} catch {
			return false;
		}
	}
	#remember(what: string) {
		try {
			localStorage.setItem(this.#storageKey(what), '1');
		} catch {
			// Not remembered; it shows again next time.
		}
	}

	/* ───────────── totals, the sentence and the quiet line ───────────── */

	readonly needsTotal = $derived(this.#countOf(this.needsCards) + (this.showAiRow ? 1 : 0));
	readonly notesTotal = $derived(this.#countOf(this.notesCards));
	readonly aheadTotal = $derived(this.#countOf(this.aheadCards));

	readonly showCapture = $derived.by(() =>
		showCaptureBox({
			canCapture: !this.familyMode && this.app.slots('today.capture').length > 0,
			fresh: this.fresh,
			plan: this.todayItems.length,
			evening: this.evening,
		}),
	);

	/** The day head sentence ("Good morning, Deniz. **3 things need you**, …") as runs. */
	readonly sentence = $derived.by(() => {
		const last = lastTonight(this.todayItems, this.now, this.timeZone);
		const firstTomorrow = this.tomorrowItems.find(
			(i) => i.start !== undefined && !i.nominal && !i.slot,
		);
		const part = partOfDay(this.now, this.timeZone);
		const { key, params } = composeSentence({
			part,
			name: firstName(this.members, this.me),
			needs: this.needsTotal,
			plan: this.todayItems.length,
			...(last && { lastTitle: last.title }),
			evening: this.evening,
			tomorrowStart: firstTomorrow?.start !== undefined ? this.clock(firstTomorrow.start) : null,
			fresh: this.fresh,
			needsHidden: !this.shows('needs'),
		});
		const text = tDynamic(`app:${key}`, { ...params, greeting: t(`home_greeting_${part}`) });
		return emphasisRuns(text);
	});

	/** Nothing at all on the page: the quiet day says it, so there is no quiet line under it. */
	readonly nothingAtAll = $derived(
		this.settled &&
			!this.showSteps &&
			!this.evening &&
			this.needsTotal === 0 &&
			this.todayItems.length === 0 &&
			this.notesTotal === 0 &&
			this.aheadTotal === 0,
	);

	/** The quiet line; a display has none (it names what a person would add). */
	readonly quiet = $derived.by(() => {
		if (!this.settled || this.familyMode) return '';
		const phrases = quietPhrases(this.allCards, this.reports, {
			planEmpty: this.shows('day') && this.dayItems.length === 0,
			planKey: 'app:home_quiet_plan',
		}).map((p) => tDynamic(p.key, p.count === undefined ? {} : { count: p.count }));
		const line = composeQuietLine(phrases, { fresh: this.fresh, hero: this.nothingAtAll });
		return line ? tDynamic(`app:${line.key}`, line.params) : '';
	});

	/* ───────────── the evening ───────────── */

	readonly showEvening = $derived(
		this.evening && this.needsTotal === 0 && !this.fresh && this.timelineLoaded,
	);
	readonly eveningText = $derived(
		this.tomorrowItems.length === 0
			? t('home_evening_text_free')
			: t('home_evening_text', {
					count: this.todayItems.length,
					tomorrow: this.tomorrowItems.length,
				}),
	);
	readonly doneLine = $derived(
		this.evening && this.todayItems.length > 0 && this.shows('done')
			? t('home_done_line', { list: doneTitles(this.todayItems).join(', ') })
			: '',
	);
	readonly tomorrowWeekday = $derived(
		new Intl.DateTimeFormat(this.format.formatLocale, {
			weekday: 'long',
			timeZone: this.timeZone,
		}).format(epochOf(this.tomorrow, '12:00', this.timeZone)),
	);

	/* ───────────── the next thing ───────────── */

	readonly mode = $derived<NextUpMode>(this.#mode ?? this.me?.nextUp ?? DEFAULT_MODE);
	/** The hero's item: the next timed thing of the day (none in the evening: the day is done). */
	readonly hero = $derived(
		this.evening ? null : nextUp(this.todayItems, this.now, this.mode, this.me?.id ?? null),
	);
	/** "Me" with nothing more of mine while the family has something: the toggle stays reachable. */
	readonly nothingForMe = $derived(
		!this.evening &&
			this.mode === 'me' &&
			!this.hero &&
			nextUp(this.todayItems, this.now, 'family', null) !== null,
	);
	readonly heroMember = $derived.by(() => {
		const id = this.hero?.members?.[0];
		const m = id ? this.members.find((x) => x.id === id) : undefined;
		return m ? { displayName: m.displayName, color: m.color } : null;
	});
	/** A quiet day: nothing timed to look forward to and nothing on the plan today. */
	readonly quietDay = $derived(
		this.settled &&
			this.showsDay &&
			!this.showSteps &&
			!this.evening &&
			!this.hero &&
			!this.nothingForMe &&
			this.todayItems.filter((i) => i.kind !== 'meal').length === 0,
	);

	/** The quiet day's sentence; a display's has nobody to wait for. */
	readonly quietText = $derived.by(() => {
		const week = this.nextDaysItems.length === 0;
		if (this.familyMode) return t(week ? 'home_quiet_text_week_family' : 'home_quiet_text_family');
		return t(week ? 'home_quiet_text_week' : 'home_quiet_text');
	});

	/** Saves whose next thing the hero shows (`core.setMyNextUp`); the page follows at once. */
	async setMode(mode: NextUpMode) {
		this.#mode = mode;
		try {
			const res = await api.POST('/api/v1/actions/core.setMyNextUp', { body: { mode } });
			if (res.error) throw new Error('not saved');
			if (session.me) session.me.nextUp = mode;
		} catch {
			this.#mode = null;
			this.app.toast(this.words.nextUpError);
		}
	}

	/* ───────────── the family ───────────── */

	/** The day by person: today's (or tomorrow's in the evening) all-day and timed items. */
	readonly days = $derived<MemberDays>(memberDays(this.dayItems, this.members));
	readonly statuses = $derived<FamilyStatus[]>(
		this.members.map((m) => ({
			id: m.id,
			displayName: m.displayName,
			color: m.color,
			status: statusText(
				statusOf(m.id, this.todayItems, this.chores, this.now),
				this.format,
				this.words.status,
			),
		})),
	);
	/**
	 * Chores as rings: every member, then anyone when it has some; none when nobody has any. With
	 * names off (a display), one ring for the family's total, as "anyone" (no person's colour).
	 */
	readonly rings = $derived.by((): ChoreRing[] => {
		if (
			!this.memberCounts ||
			!this.shows(this.countsBlock) ||
			!this.chores.some((c) => c.total > 0)
		)
			return [];
		if (!this.showNames) {
			const done = this.chores.reduce((sum, c) => sum + c.done, 0);
			const total = this.chores.reduce((sum, c) => sum + c.total, 0);
			return [{ id: 'anyone', name: this.words.family, done, total }];
		}
		const of = (id: string | null) => this.chores.find((c) => c.memberId === id);
		const anyone = of(null);
		return [
			...this.members.map((m) => ({
				id: m.id,
				name: m.displayName,
				short: m.shortName,
				color: m.color,
				done: of(m.id)?.done ?? 0,
				total: of(m.id)?.total ?? 0,
			})),
			...(anyone && anyone.total > 0
				? [{ id: 'anyone', name: this.words.anyone, done: anyone.done, total: anyone.total }]
				: []),
		];
	});
	/** Chores left for a person, or for anyone (`null`; with names off, the family's in all). */
	choresLeftFor = (memberId: string | null): number =>
		!this.shows(this.countsBlock)
			? 0
			: this.showNames
				? choresLeft(memberId, this.chores)
				: this.chores.reduce((sum, c) => sum + Math.max(0, c.total - c.done), 0);
	/** Today's meals, as a list of their own (shown or hidden by the block they belong to). */
	readonly meals = $derived(
		!this.mealsBlock || this.shows(this.mealsBlock.id)
			? this.dayItems.filter((i) => i.kind === 'meal')
			: [],
	);

	readonly photoOfTheDay = $derived<PhotoOfTheDay | null>(
		this.photo && this.shows('photo')
			? {
					src: this.photo.src,
					label: this.words.photo(formatPhotoMonth(this.photo.month, this.format.formatLocale)),
				}
			: null,
	);

	/* ───────────── formatting ───────────── */

	clock = (at: number): string => formatClock(at, this.format);
	readonly #weekdayShort = $derived(
		new Intl.DateTimeFormat(this.format.formatLocale, {
			weekday: 'short',
			timeZone: this.timeZone,
		}),
	);
	dayLabel = (day: string): string =>
		day === this.tomorrow
			? t('home_next_tomorrow')
			: this.#weekdayShort.format(epochOf(day, '12:00', this.timeZone));
	colorOf = (item: TimelineItem): string =>
		this.members.find((m) => m.id === item.members?.[0])?.color ?? '';
}

/** Listens to every prefix (none: nothing to listen to); returns what stops it. */
function onEvents(
	app: AppContext,
	prefixes: readonly string[] | undefined,
	handler: () => void,
): () => void {
	const offs = (prefixes ?? []).map((prefix) => app.onEvent(prefix, handler));
	return () => {
		for (const off of offs) off();
	};
}
