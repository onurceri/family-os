import type { AppContext } from '@famos/ui/app';
import type { InboxItem } from '../contract/index.js';
import { type Draft, loadInboxDrafts, loadItems, loadPendingDrafts } from './data.js';
import { type Capture, isWaiting, needsAction } from './item-view.js';

/** How many captures "Recent" lists. */
export const RECENT_LIMIT = 20;

const byCreated = (a: Draft, b: Draft) => a.createdAt - b.createdAt;

/**
 * What Quick add shows, kept fresh from the server's events: the person's captures with the
 * suggestions made from them, and the requests that are not from a capture.
 *
 * A capture that was just sent or seen while it was read stays in "Waiting for you" even when
 * nothing came of it ("Nothing to add") until the person removes it or leaves the page; after
 * that it only shows under Recent.
 */
export class CaptureFeed {
	items = $state<InboxItem[]>([]);
	drafts = $state<Draft[]>([]);
	requests = $state<Draft[]>([]);
	loaded = $state(false);
	failed = $state(false);
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
			const [items, inboxDrafts, pending] = await Promise.all([
				loadItems(),
				loadInboxDrafts(),
				loadPendingDrafts(),
			]);
			this.items = items;
			this.drafts = inboxDrafts;
			this.requests = pending.filter((d) => d.sourceKind !== 'inbox');
			const me = this.#app.me()?.id;
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
	 * How many suggestions wait in those captures: what the Quick add badge counts, with the
	 * requests, so the badge and the page agree (a capture can hold several).
	 */
	get waitingSuggestions(): number {
		return this.waiting.reduce((n, c) => n + c.drafts.filter(needsAction).length, 0);
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
}
