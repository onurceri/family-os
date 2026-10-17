import { getContext, setContext } from 'svelte';
import type { AnyDraftPresenter, PresenterMember, SlotContribution, SlotName } from './slots.js';

/**
 * What the app gives extension UIs (pages, widgets, draft editors). Extensions cannot import
 * the app's modules; the app provides this through Svelte context instead.
 */
export interface AppContext {
	/** Translate a namespaced key, e.g. `calendar:nav`. Reactive to locale changes. */
	t(key: string, options?: Record<string, unknown>): string;
	/** The UI language (`en`, `tr`): for words only. Never pass it to `Intl` for dates or numbers. */
	locale(): string;
	/** The family's region format (BCP 47): for numbers and money, separate from the language. */
	formatLocale(): string;
	/**
	 * BCP 47 tag for dates and times: day and month names in the UI language, the region's order
	 * where `Intl` knows it, the family's hour cycle (`dateLocale` from `@famos/time`).
	 */
	dateLocale(): string;
	/** First day of the week, ISO: 1 = Monday … 7 = Sunday. */
	weekStart(): number;
	hourCycle(): 'h12' | 'h23';
	temperatureUnit(): 'celsius' | 'fahrenheit';
	/** Active family members (refreshed on changes). */
	members(): readonly PresenterMember[];
	/**
	 * The signed-in member, if any. `nextUp`: whose next thing Today's hero shows, the family's
	 * (the default) or theirs (`core.setMyNextUp`).
	 */
	me(): (PresenterMember & { roleId: string; nextUp: 'family' | 'me' }) | null;
	/** Whether the signed-in member's role grants a capability, e.g. `core.drafts.approve`. */
	can(capability: string): boolean;
	/** Family time zone (IANA). */
	timeZone(): string;
	/** Subscribe to realtime events by name prefix, e.g. `calendar.`; returns unsubscribe. */
	onEvent(prefix: string, handler: (name: string, payload: unknown) => void): () => void;
	/** How drafts of an action are shown (from whichever extension owns the action). */
	draftPresenter(actionId: string): AnyDraftPresenter | undefined;
	/**
	 * Contributions to a slot from extensions that are turned on and whose `requires` the viewer
	 * holds, for pages that render a slot of another extension (the record page of a domain).
	 */
	slots<S extends SlotName>(name: S): readonly SlotContribution<S>[];
	/** Whether a path such as `/calendar` is a page of the app (for linking paths in text). */
	isAppPath(path: string): boolean;
	/**
	 * The page where the viewer shares things with the family (Quick add), when an extension that
	 * is turned on offers one (`NavContribution.share`) and the viewer may use it.
	 */
	share(): { path: string; labelKey: string } | undefined;
	/** Show a notice with an optional action (e.g. Undo). */
	toast(message: string, action?: { label: string; run: () => void }): void;
	/**
	 * Says a change was sent for approval, with a way to where it waits (Quick add). For every
	 * action whose result is `drafted`.
	 */
	sentForApproval(): void;
	/**
	 * What running a data-changing action would do for the viewer, as the server decides it
	 * (reactive): `apply` (directly), `suggest` (it becomes a suggestion someone approves), `no`
	 * (it is refused: show no control for it) or `depends` (the input decides, such as whose thing
	 * it is: offer the control, and ask `accessFor` with the input when a form has one). An action
	 * that is not on (its extension is off) is `no`.
	 */
	access(actionId: string): ActionAccess;
	/**
	 * The same for one input: the exact answer once the server has given it (a moment after the
	 * input stops changing; the general answer until then, `depends` included).
	 */
	accessFor(actionId: string, input: unknown): ActionAccess;
	/**
	 * What a form shows when its change goes to someone for approval: the line that says so and
	 * the save button's words. Undefined when the change is applied directly or refused. With an
	 * input, the exact answer for it.
	 */
	approval(actionId: string, input?: unknown): Approval | undefined;
	/**
	 * Whether a change of the signed-in member to the thing with this id (a task, an event, a pet)
	 * waits for someone else's approval (reactive). Rows and record pages mark it.
	 */
	awaitsApproval(id: string): boolean;
	/**
	 * The change of the signed-in member to the thing with this id that waits for someone else's
	 * approval, newest first (reactive), so a mark can say what it will become.
	 */
	awaitedChange(id: string): AwaitedChange | undefined;
	/**
	 * Runs an action through the API with an idempotency key. With `offline: true`
	 * (only for actions declared `offline`), a call that cannot reach the server is kept in the
	 * browser and sent later; it resolves with `{ queued: true }` so the page can show the
	 * change as "waiting to send". Server errors (4xx/5xx) are thrown as before.
	 */
	runAction<O = unknown>(
		actionId: string,
		input: unknown,
		options?: RunActionOptions,
	): Promise<RunActionResult<O>>;
	/** Changes of the signed-in member waiting to be sent, oldest first (reactive). */
	waiting(): readonly WaitingChange[];
	/**
	 * Whether the app is showing what was last seen (no connection). Reactive: read it in the
	 * effect that loads a page's data, so the page loads again when the connection is back.
	 */
	offline(): boolean;
	/** The query string of the current page (reactive): the place for a page's selection. */
	query(): URLSearchParams;
	/**
	 * Changes the query string of the current page without a reload. `null` removes a key.
	 * A new entry in the history by default, so Back returns to the previous selection;
	 * `replace: true` for changes that are not a navigation.
	 */
	setQuery(changes: Record<string, string | null>, options?: { replace?: boolean }): void;
}

export type ActionAccess = 'apply' | 'suggest' | 'no' | 'depends';

/** What a form shows when its change waits for approval. */
export interface Approval {
	/** The line under the form's title, already translated. */
	note: string;
	/** The save button's words, already translated. */
	saveLabel: string;
}

export interface RunActionOptions {
	/** Keep the call for later when there is no connection. */
	offline?: boolean;
	/** What was done, in the person's language, for the "could not be saved" list. */
	label?: string;
}

export type RunActionResult<O = unknown> =
	| { queued: true }
	| { queued: false; status: 'applied'; output: O }
	| { queued: false; status: 'drafted'; draftId: string };

/** A change waiting for approval, as a mark needs it to say what the thing will become. */
export interface AwaitedChange {
	actionId: string;
	/** The input it would run with (a saved edit, else what was proposed). */
	input: unknown;
	/** What the fields it changes hold now, keyed like its input; null when not known. */
	before: Readonly<Record<string, unknown>> | null;
}

/** A queued call, as pages need it to mark items "waiting to send". */
export interface WaitingChange {
	actionId: string;
	input: unknown;
}

/**
 * A registered symbol: an extension bundled on its own may bring its own copy of this module, and
 * both copies must find the context the app provides.
 */
const KEY = Symbol.for('famos.app');

export function provideAppContext(context: AppContext): void {
	setContext(KEY, context);
}

/** The app context when there is one (a shared component used outside the app, as in tests). */
export function findApp(): AppContext | undefined {
	return getContext<AppContext | undefined>(KEY);
}

export function useApp(): AppContext {
	const context = getContext<AppContext | undefined>(KEY);
	if (!context) throw new Error('useApp() called outside the FamilyOS app');
	return context;
}

type PluralSuffix = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
type Keys<Catalog> = Extract<keyof Catalog, string>;
/** Catalog keys; plural forms (`items_one`, `items_other`) are also usable by their base key. */
export type CatalogKey<Catalog> =
	| Keys<Catalog>
	| (Keys<Catalog> extends infer K
			? K extends `${infer Base}_${PluralSuffix}`
				? Base
				: never
			: never);

/** A translator bound to one namespace with keys typed by that namespace's catalog. */
export function namespaced<Catalog extends Record<string, unknown>>(
	app: AppContext,
	namespace: string,
) {
	return (key: CatalogKey<Catalog>, options?: Record<string, unknown>) =>
		app.t(`${namespace}:${key}`, options);
}
