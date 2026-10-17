<script lang="ts">
	import { formatDate, todayIn } from '@famos/time';
	import { Button } from '@famos/ui/button';
	import {
		Card,
		Chip,
		ConfirmButton,
		EmptyLine,
		focusFirstInvalid,
		Section,
		SidePanel,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Check, Clock, Plus, Repeat } from '@lucide/svelte';
	import { onDestroy } from 'svelte';
	import type { HistoryEntry, Obligation, ObligationPreset } from '../contract/index.js';
	import {
		addObligation,
		completeObligation,
		loadHistory,
		loadObligations,
		type Outcome,
		removeObligation,
		updateObligation,
	} from './data.js';
	import {
		emptyObligation,
		fromObligation,
		fromPreset,
		type ObligationFormValue,
		toFields,
		validate,
	} from './form.js';
	import { useRecords } from './i18n.js';
	import ObligationForm from './ObligationForm.svelte';
	import { dueLabel, dueStatus, stateTextClass, stillMatters } from './status.js';

	/**
	 * "What needs doing" on a record's page: duties that come back, with their due
	 * status, a quick way to mark them done, their history, and a short row of presets the domain
	 * suggests ("Usually also"). Adding and changing happen in the side panel or the phone sheet.
	 */
	let {
		recordId,
		recordKind,
		recordName,
		recordUrl,
		audience,
		presets = [],
	}: {
		recordId: string;
		recordKind: string;
		recordName: string;
		recordUrl?: string;
		audience?: string;
		presets?: readonly ObligationPreset[];
	} = $props();

	const { app, t } = useRecords();
	let now = $state(Date.now());
	const clock = setInterval(() => (now = Date.now()), 60_000);
	onDestroy(() => clearInterval(clock));
	const today = $derived(todayIn(app.timeZone(), now));

	let openList = $state<Obligation[]>([]);
	let done = $state<Obligation[]>([]);
	// A date that only passed (a warranty ended) needs nothing more: it sits with the finished ones.
	const open = $derived(openList.filter((o) => stillMatters(o, today)));
	const finished = $derived([...openList.filter((o) => !stillMatters(o, today)), ...done]);
	let loaded = $state(false);
	let loadError = $state(false);
	async function load() {
		try {
			const [current, archived] = await Promise.all([
				loadObligations(recordId),
				loadObligations(recordId, 'archived'),
			]);
			openList = current;
			// Archived with the record is not "done".
			done = archived.filter((o) => o.lastDoneOn !== null);
			loadError = false;
		} catch {
			loadError = true;
		} finally {
			loaded = true;
		}
	}
	$effect(() => {
		void recordId;
		void load();
		return app.onEvent('records.obligation.', () => void load());
	});

	// Also for people who may only suggest a change: theirs waits for approval.
	const mayAdd = $derived(app.access('records.addObligation') !== 'no');
	const mayEdit = $derived(app.access('records.updateObligation') !== 'no');
	const mayComplete = $derived(app.access('records.completeObligation') !== 'no');
	const mayRemove = $derived(app.access('records.removeObligation') !== 'no');
	const report = (outcome: Outcome, message: string) => {
		if (outcome === 'drafted') app.sentForApproval();
		else app.toast(message);
	};

	// Marking done: asks for an optional note first.
	let completing = $state<string | null>(null);
	let note = $state('');
	async function complete(o: Obligation) {
		try {
			const outcome = await completeObligation(o, note.trim() || null);
			report(outcome, t('done_saved'));
			completing = null;
			note = '';
			await load();
		} catch {
			app.toast(t('error'));
		}
	}

	// The add / edit panel.
	let editingId = $state<string | 'new' | null>(null);
	let form = $state<ObligationFormValue | null>(null);
	let baseline = $state('');
	let showErrors = $state(false);
	let busy = $state(false);
	let formEl = $state<HTMLFormElement>();
	let history = $state<HistoryEntry[] | null>(null);
	const errors = $derived(form && showErrors ? validate(form) : {});
	const dirty = $derived(form !== null && JSON.stringify(form) !== baseline);
	const usedKinds = $derived(new Set(open.map((o) => o.kind)));
	const suggestions = $derived(presets.filter((p) => !usedKinds.has(p.id)));

	function openWith(next: ObligationFormValue, id: string | 'new') {
		form = next;
		baseline = JSON.stringify(next);
		editingId = id;
		showErrors = false;
		history = null;
	}
	function openNew(preset?: ObligationPreset) {
		openWith(preset ? fromPreset(preset, app.t(preset.titleKey)) : emptyObligation(), 'new');
	}
	function openEdit(o: Obligation) {
		openWith(fromObligation(o), o.id);
		loadHistory(o.id)
			.then((h) => {
				if (editingId === o.id) history = h;
			})
			.catch(() => app.toast(t('error')));
	}
	function close() {
		editingId = null;
		form = null;
		history = null;
	}
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!form || !editingId) return;
		showErrors = true;
		if (Object.keys(validate(form)).length) {
			void focusFirstInvalid(event.currentTarget);
			return;
		}
		busy = true;
		try {
			const fields = toFields(form);
			const outcome =
				editingId === 'new'
					? await addObligation(
							{
								recordId,
								recordKind,
								recordName,
								...(recordUrl && { recordUrl }),
							},
							{ ...fields, ...(audience && { audience }) },
						)
					: await updateObligation(editingId, fields);
			report(outcome, t('saved'));
			close();
			await load();
		} catch {
			app.toast(t('error'));
		} finally {
			busy = false;
		}
	}
	async function remove(id: string) {
		try {
			report(await removeObligation(id), t('removed'));
			close();
			await load();
		} catch {
			app.toast(t('error'));
		}
	}

	const formTitle = $derived(editingId === 'new' ? t('form_title_new') : t('form_title_edit'));
	const statusLabel = (o: Obligation) => t(`status_${dueStatus(o, today)}`);
	const everyLabel = (o: Obligation) =>
		o.every?.months
			? t('every_months', { count: o.every.months })
			: o.every?.years
				? t('every_years', { count: o.every.years })
				: '';
	const dateOf = (d: string) =>
		formatDate(d, app.dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
</script>

<SidePanel
	approval={app.approval(
		editingId === 'new' ? 'records.addObligation' : 'records.updateObligation',
	)}
	open={editingId !== null}
	title={formTitle}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={t('save')}
	saveDisabled={busy}
	onsave={() => formEl?.requestSubmit()}
	{dirty}
	discard={{
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	}}
	onclose={close}
>
	{#if form && editingId}
		{@const editing = editingId}
		<form bind:this={formEl} onsubmit={submit} class="grid gap-6" aria-label={formTitle}>
			<ObligationForm bind:value={form} {errors} idPrefix="obl-{recordId}" />
		</form>
		{#if editing !== 'new'}
			<div class="mt-6 grid gap-2">
				<h3 class="text-ink-soft text-xs font-bold tracking-[0.06em] uppercase">{t('history')}</h3>
				{#if history === null}
					<p class="text-ink-soft text-sm">&hellip;</p>
				{:else if history.length === 0}
					<p class="text-ink-soft text-sm">{t('history_empty')}</p>
				{:else}
					<ul class="grid gap-1 text-sm">
						{#each history as h (h.id)}
							<li>
								<span class="font-semibold">{dateOf(h.doneOn)}</span>
								{#if h.note}<span class="text-ink-soft"> · {h.note}</span>{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
	{/if}
	{#snippet danger()}
		{#if editingId && editingId !== 'new' && mayRemove}
			{@const id = editingId}
			<ConfirmButton
				label={t('remove')}
				confirmLabel={t('remove_confirm')}
				onconfirm={() => remove(id)}
			/>
		{/if}
	{/snippet}
</SidePanel>

{#snippet addAction()}
	{#if mayAdd}
		<Button variant="ghost" size="sm" onclick={() => openNew()}
			><Plus class="size-[15px]" aria-hidden="true" />{t('add')}</Button
		>
	{/if}
{/snippet}

{#snippet chips()}
	<span class="text-ink-soft text-[13px]"
		>{open.length > 0 ? t('usually_also') : t('suggestions')}</span
	>
	{#each suggestions as preset (preset.id)}
		<Chip variant="preset" onclick={() => openNew(preset)}>
			{#snippet lead()}<Plus class="size-3.5" aria-hidden="true" />{/snippet}
			{app.t(preset.titleKey)}
		</Chip>
	{/each}
{/snippet}

<Section
	label={t('needs_title')}
	count={open.length > 0 ? open.length : undefined}
	actions={addAction}
>
	{#if loadError}
		<p class="text-attention font-semibold" role="alert">{t('error')}</p>
	{:else if loaded && open.length === 0}
		<EmptyLine text={t('needs_empty')}>
			{#snippet icon()}<Check class="text-now" />{/snippet}
			{#if mayAdd}
				<button
					type="button"
					class="text-info min-h-9 font-semibold underline underline-offset-4"
					onclick={() => openNew()}>{t('needs_add_first')}</button
				>
			{/if}
		</EmptyLine>
	{/if}

	{#if open.length > 0}
		<Card rows role="list">
			{#each open as o (o.id)}
				{@const status = dueStatus(o, today)}
				{@const assignee = app.members().find((m) => m.id === o.assigneeId)}
				<div role="listitem" class="grid">
					<div class="flex items-center">
						<button
							type="button"
							onclick={() => openEdit(o)}
							disabled={!mayEdit}
							class="enabled:hover:bg-idle/55 flex min-h-14 min-w-0 flex-1 items-center gap-3 border-0 bg-transparent px-3 py-1.5 text-start text-[length:inherit] enabled:cursor-pointer"
						>
							<span
								class="bg-idle text-ink-soft grid size-9 shrink-0 place-items-center rounded-full"
								aria-hidden="true"
							>
								{#if o.every}<Repeat class="size-[18px]" />{:else}<Clock class="size-[18px]" />{/if}
							</span>
							<span class="grid min-w-0 flex-1 gap-px">
								<span class="truncate text-[15px] leading-[1.3] font-semibold">{o.title}</span>
								<span class="text-ink-soft block overflow-hidden text-[13px]">
									<span class="meta">
										<span class="fact"
											><span class="sr-only">{statusLabel(o)}: </span><span
												class={stateTextClass(status)}
												>{dueLabel(o, today, t, app.dateLocale())}</span
											></span
										>
										{#if everyLabel(o)}<span class="fact">{everyLabel(o)}</span>{/if}
										{#if assignee || o.notes}
											<span class="fact min-w-0 truncate"
												>{[assignee?.displayName, o.notes].filter(Boolean).join(' · ')}</span
											>
										{/if}
									</span>
								</span>
							</span>
						</button>
						{#if mayComplete && !o.lapses}
							<div class="pe-3">
								<Button
									variant="secondary"
									size="sm"
									onclick={() => {
										completing = completing === o.id ? null : o.id;
										note = '';
									}}
									aria-expanded={completing === o.id}>{t('mark_done')}</Button
								>
							</div>
						{/if}
					</div>

					{#if completing === o.id}
						<form
							class="flex flex-wrap items-center gap-2 px-3 pb-3"
							onsubmit={(e) => {
								e.preventDefault();
								void complete(o);
							}}
						>
							<label for="note-{o.id}" class="sr-only">{t('done_note')}</label>
							<Input
								id="note-{o.id}"
								bind:value={note}
								maxlength={500}
								placeholder={t('done_note_placeholder')}
								autocomplete="off"
								class="min-w-0 flex-1"
							/>
							<Button type="submit" size="sm">{t('done_confirm')}</Button>
						</form>
					{/if}
				</div>
			{/each}
			{#if mayAdd && suggestions.length > 0}
				<div role="listitem" class="flex flex-wrap items-center gap-2 px-3 py-2.5">
					{@render chips()}
				</div>
			{/if}
		</Card>
	{:else if loaded && mayAdd && suggestions.length > 0}
		<div class="flex flex-wrap items-center gap-2 px-1">{@render chips()}</div>
	{/if}

	{#if finished.length > 0}
		<details class="text-sm">
			<summary class="text-ink-soft min-h-9 cursor-pointer font-semibold"
				>{t('finished', { count: finished.length })}</summary
			>
			<ul class="mt-2 grid gap-1">
				{#each finished as o (o.id)}
					<li class="text-ink-soft">
						<span class="text-ink font-semibold">{o.title}</span>
						{#if o.lastDoneOn}
							· {dateOf(o.lastDoneOn)}{:else if o.lapses}
							· {dueLabel(o, today, t, app.dateLocale())}{/if}
					</li>
				{/each}
			</ul>
		</details>
	{/if}
</Section>

<style>
	/* The due date and the repeat interval wrap to a new line whole instead of being cut, and only
	   the trailing person and notes are shortened. Each part carries the dot before it, and the row
	   is shifted one dot to the start inside a clip, so a wrapped line never begins with a dot. */
	.meta {
		display: flex;
		flex-wrap: wrap;
		margin-inline-start: -1em;
	}
	.fact {
		max-width: 100%;
	}
	.fact::before {
		content: '\00b7' / '';
		display: inline-block;
		width: 1em;
		text-align: center;
	}
</style>
