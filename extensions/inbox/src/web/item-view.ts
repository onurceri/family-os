import { type InboxItem, itemTitle } from '../contract/index.js';
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
		| 'chip_done'
		| 'chip_rejected'
		| 'chip_undone'
		| 'chip_expired'
		| 'chip_reading'
		| 'chip_failed'
		| 'chip_held'
		| 'chip_filed'
		| 'chip_nothing'
		| 'chip_question';
	count?: number;
}

const needsAction = (d: Draft) => d.status === 'pending' || d.status === 'failed';

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
	return { tone: 'idle', key: 'chip_nothing' };
}

/** The group's approve button: "Add selected" only when every picked suggestion adds something. */
export const approveSelectedKey = (
	picked: readonly { actionId: string }[],
): 'add_selected' | 'apply_selected' =>
	picked.length > 0 && picked.every((d) => isAddition(d.actionId))
		? 'add_selected'
		: 'apply_selected';
