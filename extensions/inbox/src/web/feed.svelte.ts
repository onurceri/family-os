import type { AppContext } from '@famos/ui/app';
import type { InboxItem } from '../contract/index.js';
import {
	type Draft,
	loadInboxDrafts,
	loadItems,
	loadRecentDrafts,
	loadWaitingDrafts,
} from './data.js';
import {
	type Capture,
	decidableCount,
	decidedRequests,
	isWaiting,
	type RequestGroup,
	requestGroups,
} from './item-view.js';

/** One group under "Waiting for you": a capture with its suggestions, or requests from one place. */
export type WaitingEntry =
	| { kind: 'capture'; key: string; capture: Capture; at: number }
	| { kind: 'request'; key: string; group: RequestGroup; at: number };

/** How many captures "Recent" lists. */
export const RECENT_LIMIT = 20;

/** One line under "Recent": a capture of the person's, or a request of theirs someone decided. */
export type RecentEntry =
	| { kind: 'capture'; key: string; capture: Capture; at: number }
	| { kind: 'request'; key: string; draft: Draft; at: number };

const byCreated = (a: Draft, b: Draft) => a.createdAt - b.createdAt;

/**
 * What Quick add shows, kept fresh from the server's events: the person's captures with the
 * suggestions made from them, and the requests that are not from a capture (from the assistant, a
 * connected app, or a person who may not change things directly). Every waiting suggestion the
 * person may decide is on the page.
 *
 * A capture that was just sent or seen while it was read stays in "Waiting for you" even when
 * nothing came of it ("Nothing to add") until the person removes it or leaves the page; after
 * that it only shows under Recent.
 */
export class CaptureFeed {
	items = $state<InboxItem[]>([]);
	drafts = $state<Draft[]>([]);
	requests = $state<Draft[]>([]);
	/** The person's own requests someone else decided lately. */
	decided = $state<Draft[]>([]);
	loaded = $state(false);
	failed = $state(false);
	/** The waiting suggestions from captures, for the count. */
	#waitingInbox = $state<Draft[]>([]);
	/** Captures this view has seen being read, or sent from it. */
	#seen = $state(new Set<string>());
	#app: AppContext;

	constructor(app: AppContext) {
		this.#app = app;
	}

	/** Loads now and again after every change. Returns what stops it. */
	start(): () => void {
		void this.load();
		const offItems = this.#app.onEvent('inbox.', () => void this.load());
		const offDrafts = this.#app.onEvent('core.draft.', () => void this.load());
		return () => {
			offItems();
			offDrafts();
		};
	}

	async load() {
		try {
			const [items, inboxDrafts, pending, recent] = await Promise.all([
				loadItems(),
				loadInboxDrafts(),
				loadWaitingDrafts(),
				loadRecentDrafts(),
			]);
			this.items = items;
			const waitingInbox = pending.filter((d) => d.sourceKind === 'inbox');
			// A waiting suggestion is always shown with its capture, however many newer ones there are.
			const known = new Set(inboxDrafts.map((d) => d.id));
			this.drafts = [...inboxDrafts, ...waitingInbox.filter((d) => !known.has(d.id))];
			this.requests = pending.filter((d) => d.sourceKind !== 'inbox');
			this.#waitingInbox = waitingInbox;
			const me = this.#app.me()?.id;
			this.decided = decidedRequests(recent, me, Date.now());
			for (const item of items) {
				if (
					item.createdBy === me &&
					(item.status === 'received' || item.status === 'normalized') &&
					!this.#seen.has(item.id)
				)
					this.#seen = new Set([...this.#seen, item.id]);
			}
			this.failed = false;
		} catch {
			this.failed = true;
		} finally {
			this.loaded = true;
		}
	}

	/** A capture just sent from this view: it shows at once, before the next load. */
	add(item: InboxItem) {
		this.items = [item, ...this.items.filter((i) => i.id !== item.id)];
		this.#seen = new Set([...this.#seen, item.id]);
	}

	/** The suggestions made from a capture, in the order the model proposed them. */
	draftsOf(itemId: string): Draft[] {
		return this.drafts.filter((d) => d.sourceId === itemId).toSorted(byCreated);
	}

	capture(itemId: string): Capture | undefined {
		const item = this.items.find((i) => i.id === itemId);
		return item && { item, drafts: this.draftsOf(itemId) };
	}

	/** Captures with something for the person to do or see, newest first. */
	get waiting(): Capture[] {
		const me = this.#app.me()?.id;
		return this.items
			.map((item) => ({ item, drafts: this.draftsOf(item.id) }))
			.filter((c) => isWaiting(c, c.item.createdBy === me, this.#seen.has(c.item.id)));
	}

	/**
	 * Everything under "Waiting for you", newest first: the captures and the requests from each
	 * place, side by side.
	 */
	get entries(): WaitingEntry[] {
		return [
			...this.waiting.map((capture) => ({
				kind: 'capture' as const,
				key: capture.item.id,
				capture,
				at: capture.item.createdAt,
			})),
			...requestGroups(this.requests).map((group) => ({
				kind: 'request' as const,
				key: group.key,
				group,
				at: group.latest,
			})),
		].toSorted((a, b) => b.at - a.at);
	}

	/**
	 * How many suggestions wait for this person's decision: the same set the Quick add badge
	 * counts on the server, so the badge and the page agree (a capture can hold several).
	 */
	get waitingSuggestions(): number {
		return decidableCount([...this.#waitingInbox, ...this.requests]);
	}

	/** The person's own earlier captures. */
	get recent(): Capture[] {
		const me = this.#app.me()?.id;
		const waiting = new Set(this.waiting.map((c) => c.item.id));
		return this.items
			.filter((i) => i.createdBy === me && !waiting.has(i.id))
			.slice(0, RECENT_LIMIT)
			.map((item) => ({ item, drafts: this.draftsOf(item.id) }));
	}

	/**
	 * Everything under "Recent", newest first: the person's earlier captures, and their requests
	 * that somebody decided lately (when it was decided is when it became news).
	 */
	get recentEntries(): RecentEntry[] {
		return [
			...this.recent.map((capture) => ({
				kind: 'capture' as const,
				key: capture.item.id,
				capture,
				at: capture.item.createdAt,
			})),
			...this.decided.map((draft) => ({
				kind: 'request' as const,
				key: draft.id,
				draft,
				at: draft.decidedAt ?? draft.createdAt,
			})),
		]
			.toSorted((a, b) => b.at - a.at)
			.slice(0, RECENT_LIMIT);
	}

	/** One of the person's decided requests, to open on its own. */
	decidedRequest(draftId: string): Draft | undefined {
		return this.decided.find((d) => d.id === draftId);
	}
}
