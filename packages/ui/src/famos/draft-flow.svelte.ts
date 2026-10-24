import type { DraftUnavailable } from '../draft-title.js';
import type { DraftBefore } from '../slots.js';
import type { DraftCardStatus } from './DraftCard.svelte';

/**
 * What a draft card reads of a draft: the fields of the API's draft (`Draft` from
 * `@famos/api-client`) that decide how it looks and what it may do.
 */
export interface DraftLike {
	id: string;
	actionId: string;
	status: string;
	input?: unknown;
	editedInput?: unknown;
	proposedBy?: unknown;
	app: { name: string } | null;
	summary: string | null;
	titleKey: string | null;
	subject: string | null;
	quote: string | null;
	uncertainFields: readonly string[];
	forMember: string | null;
	autoApproved: boolean;
	undoable: boolean;
	reason: 'gone' | 'settled' | 'withdrawn' | null;
	mayExist: boolean;
	mayExistSome: boolean;
	suggestedAgain: boolean;
	instead: { actionId: string; input?: unknown; at?: { date: string; time?: string } } | null;
	before: DraftBefore;
	unavailable: DraftUnavailable | null;
}

/** The calls a draft card makes (`draftClient` from `@famos/api-client`). */
export interface DraftCalls<D extends DraftLike> {
	approve(draftId: string, input?: unknown): Promise<D>;
	reject(draftId: string): Promise<D>;
	undo(draftId: string): Promise<D>;
	suggestAgain(draftId: string): Promise<D>;
	replace(draftId: string): Promise<D>;
	/** Saves an edit on the server and returns the saved input; only for cards that edit in place. */
	edit?(draftId: string, input: unknown): Promise<unknown>;
	/** Whether an approval failed because the suggestion was taken back meanwhile. */
	wasUndone(error: unknown): boolean;
}

export interface DraftFlowOptions<D extends DraftLike> {
	/** The draft as the list holds it (reactive). */
	given(): D;
	calls: DraftCalls<D>;
	/**
	 * What suggesting a taken-back draft again does: `swap` shows the new suggestion in this card
	 * from then on; `mark` leaves the card as it is (the new one joins the list as its own card)
	 * and only stops offering the button.
	 */
	suggestAgain: 'swap' | 'mark';
	/** The words of the notices, read when they are shown. */
	texts(): { approved: string; error: string; undo: string; suggestedAgain: string };
	toast(message: string, action?: { label: string; run: () => void }): void;
	/** Called after the person chose the change the suggestion offered instead. */
	onreplaced?: () => void;
}

/**
 * The state of one draft card: what this card did to its draft (approved, rejected, taken back,
 * sent again, turned into what it offered instead) until the list catches up, and the calls that
 * do it. The view around it only words and lays out.
 */
export function createDraftFlow<D extends DraftLike>(options: DraftFlowOptions<D>) {
	const { calls } = options;
	// The draft as this card turned it into the change it offered, until the list catches up.
	let swapped = $state<D | null>(null);
	// The suggestion sent again after it was taken back, when the card shows that one from then on.
	let again = $state<D | null>(null);
	// Sent again from this card, which stays as it is.
	let sentAgain = $state(false);
	let busy = $state(false);
	let local = $state<DraftCardStatus | null>(null);
	let closedBy = $state<'gone' | 'settled' | 'withdrawn' | null>(null);
	let failed = $state(false);
	// Set by an approval in this card; otherwise the draft itself says whether Undo is possible.
	let undoable = $state<boolean | null>(null);
	// An edit saved on the server, shown until the list has loaded the draft again with it.
	let saved = $state<unknown>(undefined);
	// An edit made in the open editor, not yet saved or approved.
	let edited = $state<unknown>(undefined);

	const draft = $derived(
		again ??
			(() => {
				const given = options.given();
				return swapped && swapped.id === given.id && swapped.actionId !== given.actionId
					? swapped
					: given;
			})(),
	);
	const status = $derived<DraftCardStatus>(
		local ??
			(draft.status === 'applied' ||
			draft.status === 'rejected' ||
			draft.status === 'undone' ||
			draft.status === 'expired'
				? draft.status
				: draft.status === 'failed' || failed
					? 'failed'
					: 'pending'),
	);

	async function run(work: () => Promise<void>, onError?: (error: unknown) => void) {
		busy = true;
		try {
			await work();
		} catch (error) {
			if (onError) onError(error);
			else options.toast(options.texts().error);
		} finally {
			busy = false;
		}
	}

	async function undo(id: string) {
		await run(async () => {
			const result = await calls.undo(id);
			if (result.status === 'undone' && id === draft.id) local = 'undone';
		});
	}

	return {
		get draft() {
			return draft;
		},
		get status() {
			return status;
		},
		get busy() {
			return busy;
		},
		get failed() {
			return failed;
		},
		/** Why the card closed itself, once this card decided or learnt it. */
		get reason() {
			return local ? closedBy : draft.reason;
		},
		/** Whether Undo is possible for an applied draft. */
		get undoable() {
			return undoable ?? draft.undoable;
		},
		/** Whether suggesting it again is still on offer. */
		get canSuggestAgain() {
			return !sentAgain && !draft.suggestedAgain;
		},
		get saved() {
			return saved;
		},
		get edited() {
			return edited;
		},
		set edited(value: unknown) {
			edited = value;
		},
		/** The list loaded the draft again: what was saved is in it now. */
		forgetSaved() {
			saved = undefined;
		},

		async choose() {
			await run(async () => {
				swapped = await calls.replace(draft.id);
				edited = undefined;
				saved = undefined;
				options.onreplaced?.();
			});
		},

		async approve(withInput?: unknown) {
			// Capture the id: the Undo notice outlives this card when a list moves on to the next draft.
			const id = draft.id;
			failed = false;
			await run(
				async () => {
					const result = await calls.approve(id, withInput);
					// Rejected here means what it was about is gone: the draft closed itself.
					local =
						result.status === 'applied'
							? 'applied'
							: result.status === 'rejected'
								? 'rejected'
								: null;
					if (result.status === 'rejected') closedBy = result.reason;
					undoable = result.undoable;
					failed = result.status === 'failed';
					if (result.status === 'applied') {
						const texts = options.texts();
						options.toast(
							texts.approved,
							result.undoable ? { label: texts.undo, run: () => void undo(id) } : undefined,
						);
					}
				},
				(error) => {
					// Taken back meanwhile (on another screen): it says so, and can be suggested again.
					if (calls.wasUndone(error)) local = 'undone';
					else failed = true;
				},
			);
		},

		/** Saves the edit on the server; `after` gets the saved input. */
		async saveEdit(next: unknown, after?: (saved: unknown) => void) {
			const edit = calls.edit;
			if (!edit) throw new Error('This card does not save edits on their own');
			await run(async () => {
				saved = await edit(draft.id, next);
				after?.(saved);
			});
		},

		async suggestAgain() {
			await run(async () => {
				const next = await calls.suggestAgain(draft.id);
				if (options.suggestAgain === 'swap') {
					again = next;
					local = null;
					closedBy = null;
					undoable = null;
					failed = false;
					edited = undefined;
				} else {
					sentAgain = true;
				}
				options.toast(options.texts().suggestedAgain);
			});
		},

		undo,

		async reject(withdrawing = false) {
			await run(async () => {
				await calls.reject(draft.id);
				local = 'rejected';
				closedBy = withdrawing ? 'withdrawn' : null;
			});
		},
	};
}

export type DraftFlow<D extends DraftLike> = ReturnType<typeof createDraftFlow<D>>;
