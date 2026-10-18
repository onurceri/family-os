<script lang="ts">
	import { isApiError } from '@famos/api-client';
	import { DraftCard, type DraftCardStatus } from '@famos/ui/famos';
	import {
		askedBy,
		draftHeadline,
		draftKicker,
		insteadOffer,
		type PresenterContext,
		proposedByMember,
		unavailableLine,
	} from '@famos/ui/slots';
	import type { Component } from 'svelte';
	import {
		approveDraft,
		type Draft,
		rejectDraft,
		replaceDraft,
		suggestDraftAgain,
		undoDraft,
	} from './data.js';
	import { useAssistant } from './i18n.js';

	/**
	 * A draft the assistant created, shown under its answer with the normal draft card: the
	 * presenter of the extension that owns the action renders it, and people who may approve
	 * decide here. Everyone else sees "Waiting for approval".
	 */
	let { draft: given }: { draft: Draft } = $props();
	const { app, t } = useAssistant();

	// The draft as this card turned it into the change it offered, until the list catches up.
	let swapped = $state<Draft | null>(null);
	// The suggestion sent again after it was taken back: the card shows it from then on.
	let again = $state<Draft | null>(null);
	const draft = $derived(
		again ??
			(swapped && swapped.id === given.id && swapped.actionId !== given.actionId ? swapped : given),
	);
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
	const input = $derived((draft.editedInput ?? draft.input) as Record<string, unknown>);
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
		presenter?.title(input, context) ??
			draftHeadline({
				summary: draft.summary,
				titleKey: draft.titleKey,
				actionId: draft.actionId,
				input,
				subject: draft.subject,
				t: app.t,
			}),
	);
	const mine = $derived(proposedByMember(draft.proposedBy, app.me()?.id));
	const asker = $derived(askedBy(draft.proposedBy, app.me()?.id, app.members()));
	const labels = $derived({
		approve: presenter?.approveLabel?.(context) ?? a('draft_approve'),
		edit: a('draft_edit'),
		save: a('draft_save'),
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
		} catch {
			app.toast(t('error'));
		} finally {
			busy = false;
		}
	}

	let Editor = $state<Component<{
		input: unknown;
		context: PresenterContext;
		onchange(input: unknown): void;
	}> | null>(null);
	$effect(() => {
		const load = presenter?.editor;
		if (!load) return;
		void load().then((m) => (Editor = m.default as typeof Editor));
	});

	async function approve(withInput?: unknown) {
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
			if (result.status === 'applied')
				app.toast(
					t('approved'),
					result.undoable ? { label: a('draft_undo'), run: () => void undo(id) } : undefined,
				);
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

	async function suggestAgain() {
		busy = true;
		try {
			again = await suggestDraftAgain(draft.id);
			local = null;
			closedBy = null;
			undoable = null;
			failed = false;
			edited = undefined;
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
	quiet
	kind={presenter?.kind(context) ?? draftKicker({ actionId: draft.actionId, t: app.t })}
	askedBy={asker ? app.t('app:draft_asked_by', { name: asker }) : undefined}
	icon={presenter?.icon}
	{title}
	fields={presenter?.fields(input, context, draft.before) ?? []}
	uncertain={draft.uncertainFields}
	mayExist={draft.mayExist}
	mayExistSome={draft.mayExistSome}
	instead={offer && { ...offer, onchoose: () => void choose() }}
	{status}
	error={failed || draft.status === 'failed' ? a('draft_failed') : null}
	{labels}
	{busy}
	{canDecide}
	onapprove={() => approve()}
	onreject={() => reject()}
	reason={local ? closedBy : draft.reason}
	onwithdraw={mine && !canDecide ? () => reject(true) : undefined}
	onsuggestagain={status === 'undone' && mine && !draft.suggestedAgain
		? () => void suggestAgain()
		: undefined}
	onundo={status === 'applied' && (undoable ?? draft.undoable) && canDecide
		? () => void undo(draft.id)
		: undefined}
	onsave={Editor ? () => approve(edited) : undefined}
>
	{#snippet editor()}
		{#if Editor}
			<Editor {input} {context} onchange={(next: unknown) => (edited = next)} />
		{/if}
	{/snippet}
</DraftCard>
