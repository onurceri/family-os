import { type InboxItem, itemTitle, type Skip, type SkipReason } from '../contract/index.js';
import type { Draft } from './data.js';

export { itemTitle };

/** Whether the model's label says something the title does not (ignoring case and spacing). */
export function addsToTitle(item: InboxItem, note: string | null): boolean {
	const norm = (v: string) => v.replace(/\s+/g, ' ').trim().toLowerCase();
	return Boolean(note?.trim()) && norm(note as string) !== norm(itemTitle(item));
}

/** A question for the assistant: the model said so and nothing was proposed. */
export const isQuestionForAssistant = (item: InboxItem): boolean =>
	item.status === 'extracted' && item.kind === 'question' && item.proposals === 0;

/** Where the question continues: the Ask page, with the text in its composer. */
export function askAssistantHref(item: InboxItem): string {
	const text = (item.text ?? item.transcript ?? item.title ?? '').trim();
	return `/assistant?q=${encodeURIComponent(text)}`;
}

/** The running text of an item without its title, for a one-line preview. */
export function itemPreview(item: InboxItem): string {
	const text = (item.text ?? item.url ?? item.transcript ?? '').replace(/\s+/g, ' ').trim();
	return text === itemTitle(item) ? '' : text;
}

export type ChipTone = 'attention' | 'now' | 'info' | 'idle';
export interface ItemChip {
	tone: ChipTone;
	key:
		| 'chip_suggestions'
		| 'chip_added'
		| 'chip_approved'
		| 'chip_done'
		| 'chip_rejected'
		| 'chip_undone'
		| 'chip_expired'
		| 'chip_reading'
		| 'chip_failed'
		| 'chip_held'
		| 'chip_filed'
		| 'chip_nothing'
		| 'chip_left_out'
		| 'chip_question';
	count?: number;
}

export const needsAction = (d: Draft) => d.status === 'pending' || d.status === 'failed';

/** A capture and the suggestions made from it. */
export interface Capture {
	item: InboxItem;
	drafts: readonly Draft[];
}

/**
 * Whether a capture belongs under "Waiting for you": a suggestion to decide, or (for the
 * person's own) it is being read, could not be read, is kept unread, or was seen in this view
 * and has no suggestions to show, so the person sees what became of it.
 */
export function isWaiting(capture: Capture, mine: boolean, seen: boolean): boolean {
	const { item, drafts } = capture;
	if (drafts.some(needsAction)) return true;
	if (!mine) return false;
	if (
		item.status === 'received' ||
		item.status === 'normalized' ||
		item.status === 'failed' ||
		item.status === 'held'
	)
		return true;
	return seen && drafts.length === 0;
}

/** The one line a capture is known by: the model's short label, else the start of the text. */
export function captureLine(item: InboxItem): string {
	return item.summary?.trim() || itemTitle(item);
}

/** Whether an action adds something: action ids read `<extension>.<verbNoun>`, and the verb is add or create. */
export const isAddition = (actionId: string): boolean =>
	/^(add|create)(?=[A-Z]|$)/.test(actionId.split('.').at(-1) ?? '');

/** The outcome chip of a capture. */
export function itemChip(item: InboxItem, drafts: readonly Draft[]): ItemChip {
	if (item.status === 'received' || item.status === 'normalized')
		return { tone: 'info', key: 'chip_reading' };
	if (item.status === 'failed') return { tone: 'attention', key: 'chip_failed' };
	const pending = drafts.filter(needsAction).length;
	if (pending) return { tone: 'attention', key: 'chip_suggestions', count: pending };
	const applied = drafts.filter((d) => d.status === 'applied');
	// "Added" only when everything that happened was an add; a removal or a change is just done.
	if (applied.length)
		return {
			tone: 'now',
			key: applied.every((d) => isAddition(d.actionId)) ? 'chip_added' : 'chip_done',
			count: applied.length,
		};
	if (drafts.length && drafts.every((d) => d.status === 'expired'))
		return { tone: 'idle', key: 'chip_expired' };
	// Approved and then taken back is not the same as turned down.
	const decided = drafts.filter((d) => d.status !== 'expired');
	if (decided.length && decided.every((d) => d.status === 'undone'))
		return { tone: 'idle', key: 'chip_undone' };
	if (drafts.length) return { tone: 'idle', key: 'chip_rejected' };
	if (item.status === 'filed') return { tone: 'idle', key: 'chip_filed' };
	if (item.status === 'held') return { tone: 'idle', key: 'chip_held' };
	if (isQuestionForAssistant(item)) return { tone: 'info', key: 'chip_question' };
	// Something was found and left out: "Nothing to add" would hide that it can be read again.
	if (isLeftOut(item)) return { tone: 'attention', key: 'chip_left_out', count: item.skips.length };
	return { tone: 'idle', key: 'chip_nothing' };
}

/** Read with nothing proposed, though the model did find something: every proposal was left out. */
export const isLeftOut = (item: InboxItem): boolean =>
	item.status === 'extracted' && item.proposals === 0 && item.skips.length > 0;

/** One line about the proposals left out for one reason. */
export interface SkipLine {
	reason: SkipReason;
	/** What they were about ("Ice cream, Football"), when every one of them is known. */
	names: string | null;
	count: number;
}

/** The order the reasons are told in: what the person can act on first. */
const SKIP_ORDER: readonly SkipReason[] = [
	'already',
	'unknown',
	'ambiguous',
	'not_allowed',
	'instruction',
	'incomplete',
];

/**
 * The proposals left out, one line per reason, naming them when each one's subject is known (the
 * same name once), else counting them.
 */
export function skipLines(skips: readonly Skip[]): SkipLine[] {
	return SKIP_ORDER.flatMap((reason) => {
		const these = skips.filter((skip) => skip.reason === reason);
		if (these.length === 0) return [];
		const subjects = these.map((skip) => skip.subject?.trim() ?? '');
		const named = subjects.every(Boolean);
		return [
			{ reason, names: named ? [...new Set(subjects)].join(', ') : null, count: these.length },
		];
	});
}

/**
 * The line under a suggestion's headline: its field values joined, without any that only say the
 * headline again (a one-item shopping draft is titled by the item, which is also its one field).
 */
export const metaLine = (
	headline: string,
	values: readonly string[],
	extra: readonly string[] = [],
) => {
	const same = headline.trim().toLowerCase();
	return [...values.filter((v) => v.trim().toLowerCase() !== same), ...extra]
		.filter(Boolean)
		.join(' \u00b7 ');
};

/**
 * Whether the group may add or dismiss now. A card whose edit is still open holds a change that
 * is not saved yet, so adding then would quietly leave it out.
 */
export const groupBusyState = (state: {
	busy: boolean;
	editing: number;
	picked: number;
}): { addDisabled: boolean; dismissDisabled: boolean; hint: boolean } => ({
	addDisabled: state.busy || state.editing > 0 || state.picked === 0,
	dismissDisabled: state.busy || state.editing > 0,
	hint: state.editing > 0,
});

/**
 * Whether a suggestion in a group starts ticked. One that offers to change what is already there
 * (move the event) would add a second one if the group approved it as it is, and one that seems
 * to be there already takes a second tap on its own card: neither goes in unless the person
 * ticks it. One of which only some things exist still adds the rest, so it starts ticked.
 */
export const pickedByDefault = (draft: Pick<Draft, 'instead' | 'mayExist'>): boolean =>
	!draft.instead && !draft.mayExist;

/**
 * The suggestions a group approves: the person's own ticks and unticks, and for the rest
 * whether they start ticked. Choosing the offered change is a choice too: that one is ticked.
 */
export const pickedDrafts = <D extends Pick<Draft, 'id' | 'instead' | 'mayExist'>>(
	todo: readonly D[],
	choices: ReadonlyMap<string, boolean>,
): D[] => todo.filter((d) => choices.get(d.id) ?? pickedByDefault(d));

/** The group's approve button: "Add selected" only when every picked suggestion adds something. */
export const approveSelectedKey = (
	picked: readonly { actionId: string }[],
): 'add_selected' | 'apply_selected' =>
	picked.length > 0 && picked.every((d) => isAddition(d.actionId))
		? 'add_selected'
		: 'apply_selected';

/** Where a suggestion that is not from a capture came from. */
export type RequestOrigin = 'assistant' | 'app' | 'person';

/** Suggestions from one place: one assistant answer, one connected app, or one person's requests. */
export interface RequestGroup {
	key: string;
	origin: RequestOrigin;
	/** Oldest first, the order they were made in. */
	drafts: Draft[];
	/** When the newest of them was made. */
	latest: number;
}

/** The member behind a suggestion: who made it, or who an agent made it for. */
function personBehind(draft: Draft): string {
	const by = draft.proposedBy as { kind?: string; memberId?: string; onBehalfOf?: string } | null;
	return (by?.kind === 'member' ? by.memberId : by?.onBehalfOf) ?? '';
}

export function requestOrigin(draft: Draft): RequestOrigin {
	if (draft.sourceKind === 'assistant') return 'assistant';
	if (draft.sourceKind === 'mcp') return 'app';
	return 'person';
}

/**
 * The waiting suggestions that are not from a capture, grouped by where they came from: an
 * assistant answer, a connected app (its app key), or the person who asked. Newest group first.
 */
export function requestGroups(drafts: readonly Draft[]): RequestGroup[] {
	const groups = new Map<string, RequestGroup>();
	for (const draft of drafts.filter(needsAction).toSorted((a, b) => a.createdAt - b.createdAt)) {
		const origin = requestOrigin(draft);
		const key =
			origin === 'person'
				? `person:${personBehind(draft)}`
				: `${origin}:${draft.sourceId ?? draft.id}:${personBehind(draft)}`;
		const group = groups.get(key);
		if (group) {
			group.drafts.push(draft);
			group.latest = Math.max(group.latest, draft.createdAt);
		} else groups.set(key, { key, origin, drafts: [draft], latest: draft.createdAt });
	}
	return [...groups.values()].toSorted((a, b) => b.latest - a.latest);
}

/**
 * How many of these suggestions wait for this person to decide: what the Quick add badge (the
 * server's count of waiting suggestions) counts too.
 */
export const decidableCount = (drafts: readonly Draft[]): number =>
	drafts.filter((d) => needsAction(d) && d.canDecide).length;

/** How long a decided request of the person's own stays under "Recent". */
export const DECIDED_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The person's own requests (not from a capture) that somebody else decided in the last week,
 * newest first: what they asked for and what became of it, so a "no" never just disappears.
 * One the person took back themselves is left out: they know what became of it.
 */
export function decidedRequests(
	drafts: readonly Draft[],
	memberId: string | undefined,
	now: number,
): Draft[] {
	if (!memberId) return [];
	return drafts
		.filter(
			(d) =>
				d.sourceKind !== 'inbox' &&
				!needsAction(d) &&
				d.decidedAt !== null &&
				now - d.decidedAt <= DECIDED_RECENT_MS &&
				d.decidedBy !== memberId &&
				d.reason !== 'withdrawn' &&
				personBehind(d) === memberId,
		)
		.toSorted((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
}

/** The outcome chip of a decided request. */
export function requestChip(draft: Draft): ItemChip {
	if (draft.status === 'applied') return { tone: 'now', key: 'chip_approved' };
	if (draft.status === 'undone') return { tone: 'idle', key: 'chip_undone' };
	if (draft.status === 'expired') return { tone: 'idle', key: 'chip_expired' };
	return { tone: 'idle', key: 'chip_rejected' };
}
