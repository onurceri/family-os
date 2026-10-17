<script lang="ts">
	import { Textarea } from '@famos/ui/textarea';
	import type { Obligation, RecordDocument } from '@famos/ext-records/contract';
	import { formatDate, todayIn } from '@famos/time';
	import { Button } from '@famos/ui/button';
	import {
		Card,
		ConfirmButton,
		EmptyLine,
		FIELD_REASON,
		fieldAria,
		FieldError,
		focusFirstInvalid,
		Row,
		Section,
		SidePanel,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { Check, ChevronRight, FileText, Plus, Syringe } from '@lucide/svelte';
	import {
		type Pet,
		type PetTreatment,
		TREATMENT_KINDS,
		type TreatmentKind,
	} from '../contract/index.js';
	import {
		addTreatment,
		loadDuties,
		loadPapers,
		loadTreatments,
		type Outcome,
		removeTreatment,
	} from './data.js';
	import { usePets } from './i18n.js';

	/** The treatment history of a pet: vaccines, parasite treatment, check-ups; newest first. */
	let { pet }: { pet: Pet } = $props();
	const { app, t } = usePets();

	let treatments = $state<PetTreatment[]>([]);
	let loaded = $state(false);
	let loadError = $state(false);
	async function load() {
		try {
			treatments = await loadTreatments(pet.id);
			loadError = false;
		} catch {
			loadError = true;
		} finally {
			loaded = true;
		}
	}
	$effect(() => {
		void pet.id;
		void load();
		return app.onEvent('pets.', () => void load());
	});

	// Also for people who may only suggest a change: theirs waits for approval.
	const mayAdd = $derived(app.access('pets.addTreatment') !== 'no');
	const mayRemove = $derived(app.access('pets.removeTreatment') !== 'no');
	const report = (outcome: Outcome, message: string) => {
		if (outcome === 'drafted') app.sentForApproval();
		else app.toast(message);
	};
	const dateOf = (d: string) =>
		formatDate(d, app.dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' });

	// The add form, in the panel (a sheet on phones).
	let adding = $state(false);
	let kind = $state<TreatmentKind>('vaccination');
	let givenOn = $state('');
	let product = $state('');
	let batch = $state('');
	let vet = $state('');
	let notes = $state('');
	let documentId = $state('');
	let obligationId = $state('');
	let papers = $state<RecordDocument[]>([]);
	let duties = $state<Obligation[]>([]);
	let showErrors = $state(false);
	let busy = $state(false);
	let formEl = $state<HTMLFormElement>();
	let baseline = $state('');
	const snapshot = () =>
		JSON.stringify([kind, givenOn, product, batch, vet, notes, documentId, obligationId]);
	const dirty = $derived(adding && snapshot() !== baseline);
	async function open() {
		kind = 'vaccination';
		givenOn = todayIn(app.timeZone(), Date.now());
		product = '';
		batch = '';
		vet = '';
		notes = '';
		documentId = '';
		obligationId = '';
		showErrors = false;
		baseline = snapshot();
		adding = true;
		const canSee = app.can('records.view');
		try {
			papers = canSee ? await loadPapers(pet.id) : [];
		} catch {
			papers = [];
		}
		try {
			duties = canSee && app.can('records.edit') ? await loadDuties(pet.id) : [];
		} catch {
			duties = [];
		}
	}
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		showErrors = true;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(givenOn)) {
			void focusFirstInvalid(event.currentTarget);
			return;
		}
		busy = true;
		try {
			report(
				await addTreatment({
					petId: pet.id as `pet_${string}`,
					kind,
					givenOn,
					product: product.trim(),
					batch: batch.trim() || null,
					vet: vet.trim() || null,
					notes: notes.trim() || null,
					documentId: (documentId || null) as `record_doc_${string}` | null,
					obligationId: (obligationId || null) as `obligation_${string}` | null,
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
	let viewing = $state<PetTreatment | null>(null);
	async function view(item: PetTreatment) {
		viewing = item;
		if (papers.length === 0 && item.documentId && app.can('records.view')) {
			try {
				papers = await loadPapers(pet.id);
			} catch {
				papers = [];
			}
		}
	}
	async function remove(item: PetTreatment) {
		viewing = null;
		try {
			report(await removeTreatment(item.id), t('treatment_removed'));
			await load();
		} catch {
			app.toast(t('error'));
		}
	}
	const paperName = (id: string | null) => (id ? papers.find((p) => p.id === id)?.name : undefined);
	const field =
		'border-line bg-wall text-ink focus-visible:border-info focus-visible:ring-info/25 h-[var(--ctl)] w-full rounded-[var(--r-ctl)] border px-3 text-[15px] outline-none focus-visible:ring-3';
	const label = 'text-ink-soft text-xs font-bold tracking-[0.06em] uppercase';
</script>

{#snippet optional()}<span class="text-ink-soft font-normal">{t('optional')}</span>{/snippet}

<SidePanel
	approval={app.approval('pets.addTreatment')}
	open={adding}
	title={t('treatment_form_title')}
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
		aria-label={t('treatment_form_title')}
	>
		<div class="grid grid-cols-2 gap-x-3">
			<div class="grid content-start gap-1.5">
				<Label for="treatment-kind">{t('treatment_kind')}</Label>
				<select id="treatment-kind" bind:value={kind} class={field}>
					{#each TREATMENT_KINDS as k (k)}<option value={k}>{t(`treatment_kind_${k}`)}</option
						>{/each}
				</select>
			</div>
			<div class="grid content-start gap-1.5">
				<Label for="treatment-date">{t('treatment_given_on')}</Label>
				<Input
					id="treatment-date"
					type="date"
					bind:value={givenOn}
					required
					{...fieldAria(showErrors && !givenOn ? FIELD_REASON.date : undefined, 'treatment-date')}
				/>
				<FieldError
					for="treatment-date"
					error={showErrors && !givenOn ? FIELD_REASON.date : undefined}
				/>
			</div>
		</div>
		<div class="grid gap-1.5">
			<Label for="treatment-product">{t('treatment_product')} {@render optional()}</Label>
			<Input id="treatment-product" bind:value={product} maxlength={160} autocomplete="off" />
			<small class="text-ink-soft text-[13px]">{t('treatment_product_hint')}</small>
		</div>
		<div class="grid grid-cols-2 gap-x-3">
			<div class="grid content-start gap-1.5">
				<Label for="treatment-batch">{t('treatment_batch')} {@render optional()}</Label>
				<Input id="treatment-batch" bind:value={batch} maxlength={60} autocomplete="off" />
			</div>
			<div class="grid content-start gap-1.5">
				<Label for="treatment-vet">{t('treatment_vet')} {@render optional()}</Label>
				<Input id="treatment-vet" bind:value={vet} maxlength={160} autocomplete="off" />
			</div>
		</div>
		<div class="grid gap-1.5">
			<Label for="treatment-notes">{t('treatment_notes')} {@render optional()}</Label>
			<Textarea
				id="treatment-notes"
				bind:value={notes}
				maxlength={2000}
				rows={2}
				class="{field} min-h-[84px] py-2"
			></Textarea>
		</div>
		{#if duties.length > 0}
			<div class="grid gap-1.5">
				<Label for="treatment-duty">{t('treatment_duty')} {@render optional()}</Label>
				<select id="treatment-duty" bind:value={obligationId} class={field}>
					<option value="">{t('treatment_duty_none')}</option>
					{#each duties as d (d.id)}
						<option value={d.id}
							>{t('treatment_duty_due', { title: d.title, date: dateOf(d.dueDate) })}</option
						>
					{/each}
				</select>
			</div>
		{/if}
		{#if papers.length > 0}
			<div class="grid gap-1.5">
				<Label for="treatment-paper">{t('treatment_paper')} {@render optional()}</Label>
				<select id="treatment-paper" bind:value={documentId} class={field}>
					<option value="">{t('treatment_paper_none')}</option>
					{#each papers as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
				</select>
			</div>
		{/if}
	</form>
</SidePanel>

<SidePanel
	open={viewing !== null}
	title={viewing ? `${t(`treatment_kind_${viewing.kind}`)} · ${dateOf(viewing.givenOn)}` : ''}
	closeLabel={t('close')}
	onclose={() => (viewing = null)}
>
	{#if viewing}
		{@const item = viewing}
		<div class="grid gap-4 text-[15px]">
			{#if item.product}
				<div class="grid gap-0.5">
					<span class={label}>{t('treatment_product')}</span>
					<span class="break-words">{item.product}</span>
				</div>
			{/if}
			{#if item.vet}
				<div class="grid gap-0.5">
					<span class={label}>{t('treatment_vet')}</span>
					<span class="break-words">{item.vet}</span>
				</div>
			{/if}
			{#if item.batch}
				<div class="grid gap-0.5">
					<span class={label}>{t('treatment_batch')}</span>
					<span class="break-all">{item.batch}</span>
				</div>
			{/if}
			{#if item.notes}
				<div class="grid gap-0.5">
					<span class={label}>{t('treatment_notes')}</span>
					<span class="break-words whitespace-pre-line">{item.notes}</span>
				</div>
			{/if}
			{#if paperName(item.documentId)}
				<div class="grid gap-0.5">
					<span class={label}>{t('treatment_paper')}</span>
					<span class="flex items-center gap-1.5"
						><FileText class="size-4 shrink-0" aria-hidden="true" />{paperName(
							item.documentId,
						)}</span
					>
				</div>
			{/if}
			{#if mayRemove}
				<div>
					<ConfirmButton
						label={t('remove')}
						confirmLabel={t('remove_confirm')}
						onconfirm={() => remove(item)}
					/>
				</div>
			{/if}
		</div>
	{/if}
</SidePanel>

{#snippet addAction()}
	{#if mayAdd}
		<Button variant="ghost" size="sm" onclick={open}
			><Plus class="size-[15px]" aria-hidden="true" />{t('treatment_add')}</Button
		>
	{/if}
{/snippet}

<Section
	label={t('treatment_title')}
	count={treatments.length > 0 ? treatments.length : undefined}
	actions={addAction}
>
	{#if loadError}
		<p class="text-attention font-semibold" role="alert">{t('error')}</p>
	{:else if loaded && treatments.length === 0}
		<EmptyLine text={t('treatment_empty')}>
			{#snippet icon()}<Check class="text-now" />{/snippet}
			{#if mayAdd}
				<button
					type="button"
					class="text-info min-h-9 font-semibold underline underline-offset-4"
					onclick={open}>{t('treatment_add_first')}</button
				>
			{/if}
		</EmptyLine>
	{/if}

	{#if treatments.length > 0}
		<Card rows role="list">
			{#each treatments as item (item.id)}
				<div role="listitem">
					<Row
						title={item.product || t(`treatment_kind_${item.kind}`)}
						meta={[
							item.product ? t(`treatment_kind_${item.kind}`) : null,
							dateOf(item.givenOn),
							item.vet,
						]
							.filter(Boolean)
							.join(' · ')}
						onclick={() => view(item)}
					>
						{#snippet lead()}
							<span class="bg-idle grid size-9 place-items-center rounded-full"
								><Syringe class="size-[18px]" aria-hidden="true" /></span
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
