import type { Component } from 'svelte';

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

/**
 * A `YYYY-MM-DD` written out in the reader's words and region order for a draft row, the one way
 * every card shows a day: weekday, day and month ("Sunday 25 October"), with the year only when it
 * is not the current one in the family's time zone ("Wednesday 13 October 2027"). A value that
 * is not a calendar date comes back as it was, so a model's odd answer still shows rather than
 * vanishing.
 */
export function draftDate(
	value: string,
	context: Pick<PresenterContext, 'dateLocale'> & { timeZone?: string },
	now: number = Date.now(),
): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
	const at = Date.parse(`${value}T12:00:00Z`);
	if (Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== value) return value;
	const thisYear = new Intl.DateTimeFormat('en-CA', {
		year: 'numeric',
		timeZone: context.timeZone ?? 'UTC',
	}).format(now);
	return new Intl.DateTimeFormat(context.dateLocale, {
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		...(value.slice(0, 4) === thisYear ? {} : { year: 'numeric' }),
		timeZone: 'UTC',
	}).format(at);
}

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
	/**
	 * Label of the approve button, e.g. "Add to calendar": a verb for what approving does. The
	 * input (as shown on the card) is for a presenter whose action does opposite things.
	 */
	approveLabel?(context: PresenterContext, input?: I): string;
	/** What a decided card says when the neutral "Done" is too vague, e.g. "Added to the calendar". */
	appliedLabel?(context: PresenterContext): string;
	editor?: () => Promise<{ default: Component<DraftEditorProps<I>> }>;
	/**
	 * The action takes the thing away (a delete, a removal): while it waits, the thing's mark says
	 * so ("Waiting for approval to remove") instead of listing what it would become.
	 */
	removes?: boolean;
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
 * The presenter of an action that removes or archives one thing and has nothing else to show: its
 * card reads as before ("Remove a treatment · Rabies", from the action's `draftTitle` key and the
 * name stored with the draft), and while it waits the thing's mark says it would be removed.
 */
export function removalPresenter(options: {
	actionId: string;
	/** The card's kind, already a namespaced key (`pets:kind_treatment`). */
	kindKey: string;
	/** The action's `draftTitle` key (`pets:draft_title_remove_treatment`). */
	titleKey: string;
	icon?: Component;
}): DraftPresenter<{ id: string; label?: string }> {
	return {
		actionId: options.actionId,
		kind: (c) => c.t(options.kindKey),
		...(options.icon ? { icon: options.icon } : {}),
		title: (input, c) => {
			const name = c.t(options.titleKey);
			const label = input.label?.trim();
			return label ? `${name} · ${label}` : name;
		},
		fields: () => [],
		removes: true,
	};
}

/**
 * What a mark beside a thing says while a change to it waits for approval: "Waiting for approval"
 * (to the person who asked) or "Suggested by Leo" (to one who may decide it, `by`), followed by
 * what the change makes of it, from the presenter of its action ("Due: Tue 20 Oct"). Each row gives
 * its new value alone (`DraftField.to`): the thing on screen already shows what it holds now.
 * Without a presenter, or rows, the plain words; a removal says only that it would remove it.
 */
export function awaitingText(change: {
	input: unknown;
	before: DraftBefore;
	presenter: AnyDraftPresenter | undefined;
	context: PresenterContext;
	/** The name of who asked, when it was someone else. */
	by?: string;
}): string {
	const { context, presenter, by } = change;
	if (presenter?.removes)
		return by
			? context.t('app:draft_waiting_remove_by', { name: by })
			: context.t('app:draft_waiting_remove');
	const waiting = by
		? context.t('app:draft_waiting_by', { name: by })
		: context.t('app:draft_waiting');
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
	if (parts.length === 0) return waiting;
	const text = parts.join(', ');
	return by
		? context.t('app:draft_waiting_change_by', { name: by, change: text })
		: context.t('app:draft_waiting_change', { change: text });
}
