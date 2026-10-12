<script lang="ts">
	import { DraftCard, type DraftCardStatus } from '@famos/ui/famos';
	import type { PresenterContext } from '@famos/ui/slots';
	import type { Component } from 'svelte';
	import { approveDraft, type Draft, rejectDraft, undoDraft } from './data.js';
	import { useInbox } from './i18n.js';

	/**
	 * A draft rendered by the presenter of the extension that owns its action. Quick add knows no
	 * extension: it looks the presenter up by action id.
	 */
	let {
		draft,
		compact = false,
		picked,
		onpick,
		oneditchange,
		quiet = false,
	}: {
		draft: Draft;
		compact?: boolean;
		/** In a group: whether the suggestion is ticked, and what ticking does. */
		picked?: boolean;
		onpick?: (picked: boolean) => void;
		oneditchange?: (editing: boolean) => void;
		/** In a capture's group: a calm card instead of the alarm ring. */
		quiet?: boolean;
	} = $props();
	const { app, t } = useInbox();

	const presenter = $derived(app.draftPresenter(draft.actionId));
	const context = $derived<PresenterContext>({
		t: app.t,
		members: app.members(),
		formatLocale: app.formatLocale(),
		weekStart: app.weekStart(),
		hourCycle: app.hourCycle(),
		timeZone: app.timeZone(),
	});
	const input = $derived((draft.editedInput ?? draft.input) as Record<string, unknown>);
	let edited = $state<unknown>(undefined);
	let busy = $state(false);
	let local = $state<DraftCardStatus | null>(null);
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
	const canDecide = $derived(app.can('core.drafts.approve'));
	const a = (key: string) => app.t(`app:${key}`);
	const labels = $derived({
		approve: presenter?.approveLabel?.(context) ?? a('draft_approve'),
		edit: a('draft_edit'),
		save: a('draft_save'),
		cancel: a('draft_cancel'),
		reject: a('draft_reject'),
		rejectConfirm: a('draft_reject_confirm'),
		checkThis: a('draft_check_this'),
		applied: draft.autoApproved ? a('draft_auto_approved') : a('draft_applied'),
		rejected: a('draft_rejected'),
		retry: a('draft_retry'),
		waiting: a('draft_waiting'),
		undone: a('draft_undone'),
		expired: a('draft_expired'),
		undo: a('draft_undo'),
		mayExist: a('draft_may_exist'),
		mayExistSome: a('draft_may_exist_some'),
	});

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
			local = result.status === 'applied' ? 'applied' : null;
			undoable = result.undoable;
			failed = result.status === 'failed';
			if (result.status === 'applied') {
				app.toast(
					t('approved'),
					result.undoable ? { label: a('draft_undo'), run: () => void undo(id) } : undefined,
				);
			}
		} catch {
			failed = true;
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

	async function reject() {
		busy = true;
		try {
			await rejectDraft(draft.id);
			local = 'rejected';
		} catch {
			app.toast(t('error'));
		} finally {
			busy = false;
		}
	}
</script>

<DraftCard
	kind={presenter?.kind(context) ?? draft.actionId}
	icon={presenter?.icon}
	title={presenter?.title(input, context) ?? draft.summary ?? draft.actionId}
	fields={presenter?.fields(input, context) ?? []}
	uncertain={draft.uncertainFields}
	mayExist={draft.mayExist}
	mayExistSome={draft.mayExistSome}
	{status}
	error={failed || draft.status === 'failed' ? a('draft_failed') : null}
	{labels}
	{busy}
	{canDecide}
	{compact}
	{oneditchange}
	{quiet}
	selectable={onpick
		? {
				checked: picked ?? true,
				label: t('pick_suggestion', {
					name: presenter?.title(input, context) ?? draft.summary ?? draft.actionId,
				}),
				onchange: onpick,
			}
		: undefined}
	onapprove={() => approve()}
	onreject={reject}
	onundo={status === 'applied' && (undoable ?? draft.undoable) && canDecide
		? () => void undo(draft.id)
		: undefined}
	onsave={Editor ? () => approve(edited) : undefined}
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
