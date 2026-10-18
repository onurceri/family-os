<script lang="ts">
	import { ConfirmButton, TodayRow } from '@famos/ui/famos';
	import { draftHeadline, namedInput, type PresenterContext } from '@famos/ui/slots';
	import type { Component } from 'svelte';
	import { approveDraft, type Draft, rejectDraft, undoDraft } from './data.js';
	import { useInbox } from './i18n.js';
	import { metaLine } from './item-view.js';

	/**
	 * A suggestion in Today's Needs you card: one row with Reject (two taps), Edit and the approve
	 * button inline. Approving offers Undo for a few seconds (the toast), like in Quick add.
	 */
	let { draft }: { draft: Draft } = $props();
	const { app, t } = useInbox();
	const a = (key: string) => app.t(`app:${key}`);

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
	// What the row shows names the thing it is about, even for a draft stored without its name.
	const shown = $derived(namedInput(input, draft.subject) as Record<string, unknown>);
	const fields = $derived(presenter?.fields(shown, context, draft.before) ?? []);
	const uncertain = $derived(
		fields.some((f) =>
			[...(f.path ? [f.path] : []), ...(f.paths ?? [])].some((p) =>
				(draft.uncertainFields ?? []).includes(p),
			),
		),
	);
	const headline = $derived(
		presenter?.title(shown, context) ??
			draftHeadline({
				summary: draft.summary,
				titleKey: draft.titleKey,
				actionId: draft.actionId,
				input: shown,
				subject: draft.subject,
				t: app.t,
			}),
	);
	const meta = $derived(
		metaLine(
			headline,
			fields.map((f) => f.value),
			uncertain ? [a('draft_check_this')] : [],
		),
	);

	let busy = $state(false);
	let gone = $state(false);
	let editing = $state(false);
	let edited = $state<unknown>(undefined);
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

	async function undo(id: string) {
		try {
			await undoDraft(id);
		} catch {
			app.toast(t('error'));
		}
	}
	async function approve(withInput?: unknown) {
		// Capture the id: the Undo toast outlives this row when the list moves on.
		const id = draft.id;
		busy = true;
		try {
			const result = await approveDraft(id, withInput);
			if (result.status === 'applied') {
				gone = true;
				app.toast(
					t('approved'),
					result.undoable ? { label: a('draft_undo'), run: () => void undo(id) } : undefined,
				);
			} else if (result.status === 'failed') {
				app.toast(a('draft_failed'));
			}
		} catch {
			app.toast(a('draft_failed'));
		} finally {
			busy = false;
		}
	}
	async function reject() {
		busy = true;
		try {
			await rejectDraft(draft.id);
			gone = true;
		} catch {
			app.toast(t('error'));
		} finally {
			busy = false;
		}
	}
	const buttonClass =
		'focus-visible:ring-ring min-h-11 rounded-lg px-4 text-sm font-bold focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50';
</script>

{#if !gone}
	<TodayRow
		variant="needs"
		{...presenter?.icon ? { icon: presenter.icon } : {}}
		title={headline}
		{meta}
		{uncertain}
		href="/add"
	>
		{#snippet trailing()}
			<ConfirmButton
				label={a('draft_reject')}
				confirmLabel={a('draft_reject_confirm')}
				onconfirm={reject}
				disabled={busy}
			/>
			{#if Editor && !draft.instead}
				<button
					type="button"
					class="text-ink-soft hover:bg-idle {buttonClass}"
					disabled={busy}
					aria-expanded={editing}
					onclick={() => (editing = !editing)}>{a('draft_edit')}</button
				>
			{/if}
			<!-- One that could change what is already there is decided on its card in Quick add, where
			the change is offered: approving it here in one tap would add a second one. -->
			{#if !draft.instead}
				<button
					type="button"
					class="bg-idle text-ink hover:bg-line {buttonClass}"
					disabled={busy}
					onclick={() => approve()}
					>{presenter?.approveLabel?.(context) ?? a('draft_approve')}</button
				>
			{/if}
		{/snippet}
		{#snippet below()}
			{#if editing && Editor}
				<div class="grid gap-3 px-4 pb-4">
					<Editor
						{input}
						{context}
						uncertain={draft.uncertainFields}
						onchange={(next: unknown) => (edited = next)}
					/>
					<div class="flex justify-end gap-2">
						<button
							type="button"
							class="text-ink-soft hover:bg-idle {buttonClass}"
							onclick={() => (editing = false)}>{a('draft_cancel')}</button
						>
						<button
							type="button"
							class="bg-idle text-ink hover:bg-line {buttonClass}"
							disabled={busy}
							onclick={() => approve(edited)}>{a('draft_save')}</button
						>
					</div>
				</div>
			{/if}
		{/snippet}
	</TodayRow>
{/if}
