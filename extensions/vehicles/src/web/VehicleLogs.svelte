<script lang="ts">
	import { Textarea } from '@famos/ui/textarea';
	import type { RecordDocument } from '@famos/ext-records/contract';
	import { formatDate, todayIn } from '@famos/time';
	import { Button } from '@famos/ui/button';
	import { Card, ConfirmButton, EmptyLine, Row, Section, SidePanel } from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { Check, ChevronRight, FileText, Plus, Wrench } from '@lucide/svelte';
	import { LOG_KINDS, type LogKind, type Vehicle, type VehicleLog } from '../contract/index.js';
	import { addLog, loadLogs, loadPapers, type Outcome, removeLog } from './data.js';
	import { useVehicles } from './i18n.js';

	/** The service and repair log of a vehicle: date, place and what was done, newest first. */
	let { vehicle }: { vehicle: Vehicle } = $props();
	const { app, t } = useVehicles();

	let logs = $state<VehicleLog[]>([]);
	let loaded = $state(false);
	let loadError = $state(false);
	async function load() {
		try {
			logs = await loadLogs(vehicle.id);
			loadError = false;
		} catch {
			loadError = true;
		} finally {
			loaded = true;
		}
	}
	$effect(() => {
		void vehicle.id;
		void load();
		return app.onEvent('vehicles.', () => void load());
	});

	const canEdit = $derived(app.can('vehicles.edit'));
	const report = (outcome: Outcome, message: string) =>
		app.toast(outcome === 'drafted' ? t('sent_for_approval') : message);
	const dateOf = (d: string) =>
		formatDate(d, app.dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' });

	// The add form, in the panel (a sheet on phones).
	let adding = $state(false);
	let kind = $state<LogKind>('service');
	let doneOn = $state('');
	let place = $state('');
	let notes = $state('');
	let documentId = $state('');
	let papers = $state<RecordDocument[]>([]);
	let showErrors = $state(false);
	let busy = $state(false);
	let formEl = $state<HTMLFormElement>();
	let baseline = $state('');
	const snapshot = () => JSON.stringify([kind, doneOn, place, notes, documentId]);
	const dirty = $derived(adding && snapshot() !== baseline);
	async function open() {
		kind = 'service';
		doneOn = todayIn(app.timeZone(), Date.now());
		place = '';
		notes = '';
		documentId = '';
		showErrors = false;
		baseline = snapshot();
		adding = true;
		try {
			papers = app.can('records.view') ? await loadPapers(vehicle.id) : [];
		} catch {
			papers = [];
		}
	}
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		showErrors = true;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(doneOn)) return;
		busy = true;
		try {
			report(
				await addLog({
					vehicleId: vehicle.id,
					kind,
					doneOn,
					place: place.trim() || null,
					notes: notes.trim() || null,
					documentId: (documentId || null) as `record_doc_${string}` | null,
				}),
				t('saved'),
			);
			adding = false;
			await load();
		} catch {
			app.toast(t('error'));
		} finally {
			busy = false;
		}
	}

	// Reading an entry: a panel with Remove.
	let viewing = $state<VehicleLog | null>(null);
	async function view(log: VehicleLog) {
		viewing = log;
		if (papers.length === 0 && log.documentId && app.can('records.view')) {
			try {
				papers = await loadPapers(vehicle.id);
			} catch {
				papers = [];
			}
		}
	}
	async function remove(log: VehicleLog) {
		viewing = null;
		try {
			report(await removeLog(log.id), t('log_removed'));
			await load();
		} catch {
			app.toast(t('error'));
		}
	}
	const paperName = (id: string | null) => (id ? papers.find((p) => p.id === id)?.name : undefined);
	const field =
		'border-line bg-wall text-ink focus-visible:border-info focus-visible:ring-info/25 h-[var(--ctl)] w-full rounded-[var(--r-ctl)] border px-3 text-[15px] outline-none focus-visible:ring-3';
</script>

<SidePanel
	open={adding}
	title={t('log_form_title')}
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
	onclose={() => (adding = false)}
>
	<form
		bind:this={formEl}
		onsubmit={submit}
		class="grid gap-[18px]"
		aria-label={t('log_form_title')}
	>
		<div class="grid grid-cols-2 gap-x-3">
			<div class="grid content-start gap-1.5">
				<Label for="log-kind">{t('log_kind')}</Label>
				<select id="log-kind" bind:value={kind} class={field}>
					{#each LOG_KINDS as k (k)}<option value={k}>{t(`log_kind_${k}`)}</option>{/each}
				</select>
			</div>
			<div class="grid content-start gap-1.5">
				<Label for="log-date">{t('log_done_on')}</Label>
				<Input
					id="log-date"
					type="date"
					bind:value={doneOn}
					required
					aria-invalid={showErrors && !doneOn ? 'true' : undefined}
				/>
			</div>
		</div>
		<div class="grid gap-1.5">
			<Label for="log-place"
				>{t('log_place')} <span class="text-ink-soft font-normal">{t('optional')}</span></Label
			>
			<Input id="log-place" bind:value={place} maxlength={160} autocomplete="off" />
			<small class="text-ink-soft text-[13px]">{t('log_place_hint')}</small>
		</div>
		<div class="grid gap-1.5">
			<Label for="log-notes"
				>{t('log_notes')} <span class="text-ink-soft font-normal">{t('optional')}</span></Label
			>
			<Textarea
				id="log-notes"
				bind:value={notes}
				maxlength={2000}
				rows={3}
				class="{field} min-h-[84px] py-2"
			></Textarea>
			<small class="text-ink-soft text-[13px]">{t('log_notes_hint')}</small>
		</div>
		{#if papers.length > 0}
			<div class="grid gap-1.5">
				<Label for="log-paper"
					>{t('log_paper')} <span class="text-ink-soft font-normal">{t('optional')}</span></Label
				>
				<select id="log-paper" bind:value={documentId} class={field}>
					<option value="">{t('log_paper_none')}</option>
					{#each papers as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
				</select>
			</div>
		{/if}
	</form>
</SidePanel>

<SidePanel
	open={viewing !== null}
	title={viewing ? `${t(`log_kind_${viewing.kind}`)} · ${dateOf(viewing.doneOn)}` : ''}
	closeLabel={t('close')}
	onclose={() => (viewing = null)}
>
	{#if viewing}
		{@const log = viewing}
		<div class="grid gap-4 text-[15px]">
			{#if log.place}
				<div class="grid gap-0.5">
					<span class="text-ink-soft text-xs font-bold tracking-[0.06em] uppercase"
						>{t('log_place')}</span
					>
					<span class="break-words">{log.place}</span>
				</div>
			{/if}
			{#if log.notes}
				<div class="grid gap-0.5">
					<span class="text-ink-soft text-xs font-bold tracking-[0.06em] uppercase"
						>{t('log_notes')}</span
					>
					<span class="break-words whitespace-pre-line">{log.notes}</span>
				</div>
			{/if}
			{#if paperName(log.documentId)}
				<div class="grid gap-0.5">
					<span class="text-ink-soft text-xs font-bold tracking-[0.06em] uppercase"
						>{t('log_paper')}</span
					>
					<span class="flex items-center gap-1.5"
						><FileText class="size-4 shrink-0" aria-hidden="true" />{paperName(
							log.documentId,
						)}</span
					>
				</div>
			{/if}
			{#if canEdit}
				<div>
					<ConfirmButton
						label={t('remove')}
						confirmLabel={t('remove_confirm')}
						onconfirm={() => remove(log)}
					/>
				</div>
			{/if}
		</div>
	{/if}
</SidePanel>

{#snippet addAction()}
	{#if canEdit}
		<Button variant="ghost" size="sm" onclick={open}
			><Plus class="size-[15px]" aria-hidden="true" />{t('log_add')}</Button
		>
	{/if}
{/snippet}

<Section
	label={t('log_title')}
	count={logs.length > 0 ? logs.length : undefined}
	actions={addAction}
>
	{#if loadError}
		<p class="text-attention font-semibold" role="alert">{t('error')}</p>
	{:else if loaded && logs.length === 0}
		<EmptyLine text={t('log_empty')}>
			{#snippet icon()}<Check class="text-now" />{/snippet}
			{#if canEdit}
				<button
					type="button"
					class="text-info min-h-9 font-semibold underline underline-offset-4"
					onclick={open}>{t('log_add_first')}</button
				>
			{/if}
		</EmptyLine>
	{/if}

	{#if logs.length > 0}
		<Card rows role="list">
			{#each logs as log (log.id)}
				<div role="listitem">
					<Row
						title="{t(`log_kind_${log.kind}`)} · {dateOf(log.doneOn)}"
						meta={[log.place, log.notes].filter(Boolean).join(' · ') || undefined}
						onclick={() => view(log)}
					>
						{#snippet lead()}
							<span class="bg-idle grid size-9 place-items-center rounded-full"
								><Wrench class="size-[18px]" aria-hidden="true" /></span
							>
						{/snippet}
						{#snippet trail()}
							<ChevronRight class="text-ink-soft size-4" aria-hidden="true" />
						{/snippet}
					</Row>
				</div>
			{/each}
		</Card>
	{/if}
</Section>
