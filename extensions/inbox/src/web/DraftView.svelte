<script lang="ts">
	import { isApiError } from '@famos/api-client';
	import { DraftCard, type DraftCardStatus } from '@famos/ui/famos';
	import {
		draftByline,
		draftHeadline,
		draftKicker,
		insteadOffer,
		namedInput,
		type PresenterContext,
		proposedByMember,
		unavailableLine,
	} from '@famos/ui/slots';
	import type { Component } from 'svelte';
	import {
		approveDraft,
		type Draft,
		editDraft,
		rejectDraft,
		replaceDraft,
		suggestDraftAgain,
		undoDraft,
	} from './data.js';
	import { useInbox } from './i18n.js';

	/**
	 * A draft rendered by the presenter of the extension that owns its action. Quick add knows no
	 * extension: it looks the presenter up by action id.
	 */
	let {
		draft: given,
		compact = false,
		picked,
		onpick,
		oneditchange,
		onedit,
		onreplaced,
		quiet = false,
		byline = true,
		groupLine,
	}: {
		draft: Draft;
		compact?: boolean;
		/** In a group: whether the suggestion is ticked, and what ticking does. */
		picked?: boolean;
		onpick?: (picked: boolean) => void;
		oneditchange?: (editing: boolean) => void;
		/**
		 * In a group: called after the person's edit was saved on the server (`core.editDraft`),
		 * with the saved input. The card itself approves nothing when it is saved: the group
		 * approves what is stored.
		 */
		onedit?: (input: unknown) => void;
		/**
		 * Called when the person chose the change the suggestion offered instead: an edit saved for
		 * what it was before no longer fits it.
		 */
		onreplaced?: () => void;
		/** Whether to say who asked, when it was somebody else (a group already names the sharer). */
		byline?: boolean;
		/** In a capture's group: a calm card instead of the alarm ring. */
		quiet?: boolean;
		/** In a capture's group: the group's own line, which no card repeats as its title. */
		groupLine?: string;
	} = $props();
	const { app, t } = useInbox();

	// The draft as this card turned it into the change it offered, until the list catches up.
	let swapped = $state<Draft | null>(null);
	const draft = $derived(
		swapped && swapped.id === given.id && swapped.actionId !== given.actionId ? swapped : given,
	);
	// Sent again from this card: the new suggestion joins the list as its own card.
	let sentAgain = $state(false);
	const presenter = $derived(app.draftPresenter(draft.actionId));
	const context = $derived<PresenterContext>({
		t: app.t,
		members: app.members(),
		formatLocale: app.formatLocale(),
		dateLocale: app.dateLocale(),
		weekStart: app.weekStart(),
		hourCycle: app.hourCycle(),
		timeZone: app.timeZone(),
	});
	// An edit just saved, shown until the list has loaded the draft again with it.
	let saved = $state<unknown>(undefined);
	$effect(() => {
		void given;
		saved = undefined;
	});
	const input = $derived((saved ?? draft.editedInput ?? draft.input) as Record<string, unknown>);
	// What the card shows names the thing it is about, even for a draft stored without its name.
	const shown = $derived(namedInput(input, draft.subject) as Record<string, unknown>);
	let edited = $state<unknown>(undefined);
	let busy = $state(false);
	let local = $state<DraftCardStatus | null>(null);
	let closedBy = $state<'gone' | 'settled' | 'withdrawn' | null>(null);
	let failed = $state(false);
	// Set by an approval in this card; otherwise the draft itself says whether Undo is possible.
	let undoable = $state<boolean | null>(null);
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
	// A draft addressed to me (a memory, a question) is mine to decide, whatever my role.
	const canDecide = $derived(
		!draft.unavailable &&
			(app.can('core.drafts.approve') ||
				(draft.forMember !== null && draft.forMember === app.me()?.id)),
	);
	const a = (key: string) => app.t(`app:${key}`);
	const title = $derived(
		presenter?.title(shown, context) ??
			draftHeadline({
				summary: draft.summary,
				titleKey: draft.titleKey,
				actionId: draft.actionId,
				input: shown,
				subject: draft.subject,
				groupLine,
				t: app.t,
			}),
	);
	const mine = $derived(proposedByMember(draft.proposedBy, app.me()?.id));
	const asker = $derived(
		byline ? draftByline(draft, app.me()?.id, app.members(), app.t) : undefined,
	);
	const labels = $derived({
		approve: presenter?.approveLabel?.(context, shown) ?? a('draft_approve'),
		edit: a('draft_edit'),
		save: onedit ? a('draft_save_edit') : a('draft_save'),
		cancel: a('draft_cancel'),
		reject: a('draft_reject'),
		rejectConfirm: a('draft_reject_confirm'),
		checkThis: a('draft_check_this'),
		applied: draft.autoApproved
			? a('draft_auto_approved')
			: (presenter?.appliedLabel?.(context) ?? a('draft_applied')),
		rejected: a('draft_rejected'),
		retry: a('draft_retry'),
		waiting: draft.unavailable
			? unavailableLine(draft.unavailable, app.locale(), app.t)
			: a('draft_waiting'),
		undone: a('draft_undone'),
		expired: a('draft_expired'),
		gone: a('draft_gone'),
		settled: a('draft_settled'),
		approveConfirm: a('draft_approve_confirm'),
		withdrawn: a('draft_withdrawn'),
		withdraw: a('draft_withdraw'),
		undo: a('draft_undo'),
		suggestAgain: a('draft_suggest_again'),
		mayExist: a('draft_may_exist'),
		mayExistSome: a('draft_may_exist_some'),
		addAsNew: a('draft_add_as_new'),
	});
	const offer = $derived(
		insteadOffer({
			instead: draft.instead,
			presenter: draft.instead ? app.draftPresenter(draft.instead.actionId) : undefined,
			context,
			t: app.t,
		}),
	);

	async function choose() {
		busy = true;
		try {
			swapped = await replaceDraft(draft.id);
			edited = undefined;
			saved = undefined;
			onreplaced?.();
		} catch {
			app.toast(t('error'));
		} finally {
			busy = false;
		}
	}

	let Editor = $state<Component<{
		input: unknown;
		context: PresenterContext;
		uncertain?: readonly string[];
		onchange(input: unknown): void;
	}> | null>(null);
	$effect(() => {
		const load = presenter?.editor;
		if (!load) return;
		void load().then((m) => (Editor = m.default as typeof Editor));
	});

	async function approve(withInput?: unknown) {
		// Capture the id: the Undo toast outlives this card when a list moves on to the next draft.
		const id = draft.id;
		busy = true;
		failed = false;
		try {
			const result = await approveDraft(id, withInput);
			// Rejected here means what it was about is gone: the draft closed itself.
			local =
				result.status === 'applied' ? 'applied' : result.status === 'rejected' ? 'rejected' : null;
			if (result.status === 'rejected') closedBy = result.reason;
			undoable = result.undoable;
			failed = result.status === 'failed';
			if (result.status === 'applied') {
				app.toast(
					t('approved'),
					result.undoable ? { label: a('draft_undo'), run: () => void undo(id) } : undefined,
				);
			}
		} catch (error) {
			// Taken back meanwhile (on another screen): it says so, and can be suggested again.
			if (
				isApiError(error) &&
				(error.details as { status?: unknown } | undefined)?.status === 'undone'
			)
				local = 'undone';
			else failed = true;
		} finally {
			busy = false;
		}
	}

	async function saveEdit(next: unknown) {
		busy = true;
		try {
			saved = await editDraft(draft.id, next);
			onedit?.(saved);
		} catch {
			app.toast(t('error'));
		} finally {
			busy = false;
		}
	}

	async function suggestAgain() {
		busy = true;
		try {
			await suggestDraftAgain(draft.id);
			sentAgain = true;
			app.toast(a('draft_suggested_again'));
		} catch {
			app.toast(t('error'));
		} finally {
			busy = false;
		}
	}

	async function undo(id: string) {
		busy = true;
		try {
			const result = await undoDraft(id);
			if (result.status === 'undone' && id === draft.id) local = 'undone';
		} catch {
			app.toast(t('error'));
		} finally {
			busy = false;
		}
	}

	async function reject(withdrawing = false) {
		busy = true;
		try {
			await rejectDraft(draft.id);
			local = 'rejected';
			closedBy = withdrawing ? 'withdrawn' : null;
		} catch {
			app.toast(t('error'));
		} finally {
			busy = false;
		}
	}
</script>

<DraftCard
	kind={presenter?.kind(context) ?? draftKicker({ actionId: draft.actionId, t: app.t })}
	askedBy={asker}
	icon={presenter?.icon}
	{title}
	source={draft.quote ? app.t('app:draft_from_message', { quote: draft.quote }) : undefined}
	fields={presenter?.fields(shown, context, draft.before) ?? []}
	uncertain={draft.uncertainFields}
	mayExist={draft.mayExist}
	mayExistSome={draft.mayExistSome}
	instead={offer && { ...offer, onchoose: () => void choose() }}
	{status}
	error={failed || draft.status === 'failed' ? a('draft_failed') : null}
	{labels}
	{busy}
	{canDecide}
	{compact}
	oneditchange={(on) => {
		if (on) edited = undefined;
		oneditchange?.(on);
	}}
	{quiet}
	selectable={onpick
		? {
				checked: picked ?? true,
				label: t('pick_suggestion', {
					name: title,
				}),
				onchange: onpick,
			}
		: undefined}
	onapprove={() => approve()}
	onreject={() => reject()}
	reason={local ? closedBy : draft.reason}
	onwithdraw={mine && !canDecide ? () => reject(true) : undefined}
	onsuggestagain={status === 'undone' && mine && !sentAgain && !draft.suggestedAgain
		? () => void suggestAgain()
		: undefined}
	onundo={status === 'applied' && (undoable ?? draft.undoable) && canDecide
		? () => void undo(draft.id)
		: undefined}
	onsave={Editor
		? () => {
				if (!onedit) return void approve(edited);
				if (edited === undefined) return;
				void saveEdit(edited);
			}
		: undefined}
>
	{#snippet editor()}
		{#if Editor}
			<Editor
				{input}
				{context}
				uncertain={draft.uncertainFields}
				onchange={(next: unknown) => (edited = next)}
			/>
		{/if}
	{/snippet}
</DraftCard>
