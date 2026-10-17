<script lang="ts">
	import { addDays, compareDates, formatDate, todayIn } from '@famos/time';
	import { Button } from '@famos/ui/button';
	import {
		Card,
		Dialog,
		EmptyLine,
		IconButton,
		Menu,
		type MenuItem,
		Pill,
		Section,
		SidePanel,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { Ellipsis, FileText, Pencil, Plus, Unlink } from '@lucide/svelte';
	import { DOCUMENT_LABELS, type DocumentLabel, type RecordDocument } from '../contract/index.js';
	import {
		detachDocument,
		documentUrl,
		loadDocuments,
		type Outcome,
		updateDocument,
	} from './data.js';
	import { useRecords } from './i18n.js';

	/** "Papers" on a record's page: the files filed to it, with label and expiry. */
	let { recordId }: { recordId: string } = $props();

	const { app, t } = useRecords();
	const today = $derived(todayIn(app.timeZone(), Date.now()));
	const mayAttach = $derived(app.access('records.attachDocument') !== 'no');
	const mayEdit = $derived(app.access('records.updateDocument') !== 'no');
	const mayDetach = $derived(app.access('records.detachDocument') !== 'no');

	let docs = $state<RecordDocument[]>([]);
	let loaded = $state(false);
	let loadError = $state(false);
	async function load() {
		try {
			docs = await loadDocuments(recordId);
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
		return app.onEvent('records.document.', () => void load());
	});

	const report = (outcome: Outcome, message: string) => {
		if (outcome === 'drafted') app.sentForApproval();
		else app.toast(message);
	};

	// Changing label and expiry, in the panel.
	let editing = $state<RecordDocument | null>(null);
	let label = $state<DocumentLabel>('other');
	let expiresOn = $state('');
	let baseline = $state('');
	let busy = $state(false);
	const dirty = $derived(editing !== null && JSON.stringify([label, expiresOn]) !== baseline);
	function edit(d: RecordDocument) {
		editing = d;
		label = d.label;
		expiresOn = d.expiresOn ?? '';
		baseline = JSON.stringify([label, expiresOn]);
	}
	async function save() {
		const d = editing;
		if (!d) return;
		busy = true;
		try {
			report(await updateDocument(d.id, { label, expiresOn: expiresOn || null }), t('saved'));
			editing = null;
			await load();
		} catch {
			app.toast(t('error'));
		} finally {
			busy = false;
		}
	}

	// Detaching asks first (the action sits in a menu).
	let detaching = $state<RecordDocument | null>(null);
	async function detach() {
		const d = detaching;
		if (!d) return;
		detaching = null;
		try {
			report(await detachDocument(d.id), t('detached'));
			await load();
		} catch {
			app.toast(t('error'));
		}
	}

	// The phone's action sheet, one for every row.
	const itemsOf = (d: RecordDocument): MenuItem[] => [
		...(mayEdit ? [{ id: 'edit', label: t('edit'), icon: pencil, onselect: () => edit(d) }] : []),
		...(mayDetach
			? [
					{
						id: 'detach',
						label: t('detach'),
						icon: unlink,
						danger: true,
						onselect: () => (detaching = d),
					},
				]
			: []),
	];

	function expiry(d: RecordDocument): { text: string; warn: 'attention' | 'heat' | null } | null {
		if (!d.expiresOn) return null;
		const date = formatDate(d.expiresOn, app.dateLocale(), {
			day: 'numeric',
			month: 'short',
			year: 'numeric',
		});
		if (compareDates(d.expiresOn, today) < 0)
			return { text: t('expired', { date }), warn: 'attention' };
		return {
			text: t('expires', { date }),
			warn: compareDates(d.expiresOn, addDays(today, 30)) <= 0 ? 'heat' : null,
		};
	}
</script>

{#snippet pencil()}<Pencil class="size-4" />{/snippet}
{#snippet unlink()}<Unlink class="size-4" />{/snippet}

<SidePanel
	approval={app.approval('records.updateDocument')}
	open={editing !== null}
	title={editing?.name ?? t('papers_title')}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={t('save')}
	saveDisabled={busy}
	onsave={save}
	{dirty}
	discard={{
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	}}
	onclose={() => (editing = null)}
>
	<form
		class="grid gap-[18px]"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<div class="grid gap-1.5">
			<Label for="paper-label-{recordId}">{t('field_label')}</Label>
			<select
				id="paper-label-{recordId}"
				bind:value={label}
				class="border-line bg-wall text-ink focus-visible:border-info focus-visible:ring-info/25 h-[var(--ctl)] w-full rounded-[var(--r-ctl)] border px-3 text-[15px] outline-none focus-visible:ring-3"
			>
				{#each DOCUMENT_LABELS as l (l)}<option value={l}>{t(`label_${l}`)}</option>{/each}
			</select>
		</div>
		<div class="grid gap-1.5">
			<Label for="paper-expires-{recordId}"
				>{t('field_expires')} <span class="text-ink-soft font-normal">{t('optional')}</span></Label
			>
			<Input id="paper-expires-{recordId}" type="date" bind:value={expiresOn} />
		</div>
	</form>
</SidePanel>

<Dialog
	open={detaching !== null}
	title={t('detach_title', { name: detaching?.name ?? '' })}
	description={t('detach_hint')}
	onclose={() => (detaching = null)}
>
	{#snippet actions()}
		<Button variant="ghost" data-autofocus onclick={() => (detaching = null)}>{t('cancel')}</Button>
		<Button variant="danger" data-armed="true" onclick={detach}>{t('detach')}</Button>
	{/snippet}
</Dialog>

{#snippet addAction()}
	{#if mayAttach}
		<Button variant="ghost" size="sm" href="/add"
			><Plus class="size-[15px]" aria-hidden="true" />{t('papers_add')}</Button
		>
	{/if}
{/snippet}

<Section
	label={t('papers_title')}
	count={docs.length > 0 ? docs.length : undefined}
	actions={addAction}
>
	{#if loadError}
		<p class="text-attention font-semibold" role="alert">{t('error')}</p>
	{:else if loaded && docs.length === 0}
		<EmptyLine text={t('papers_empty')}>
			{#snippet icon()}<FileText />{/snippet}
			<a
				href="/add"
				class="text-info inline-flex min-h-9 items-center font-semibold underline underline-offset-4"
				>{t('papers_share')}</a
			>
		</EmptyLine>
	{/if}

	{#if docs.length > 0}
		<Card rows role="list">
			{#each docs as d (d.id)}
				{@const exp = expiry(d)}
				<div role="listitem" class="flex items-center">
					<a
						href={documentUrl(d.id)}
						target="_blank"
						rel="noopener"
						aria-label={t('open_paper', { name: d.name })}
						class="hover:bg-idle/55 flex min-h-14 min-w-0 flex-1 items-center gap-3 px-3 py-1.5"
					>
						<span
							class="bg-idle text-ink-soft grid size-9 shrink-0 place-items-center rounded-full"
							aria-hidden="true"><FileText class="size-[18px]" /></span
						>
						<span class="grid min-w-0 flex-1 gap-px">
							<span class="truncate text-[15px] leading-[1.3] font-semibold">{d.name}</span>
							<span class="text-ink-soft truncate text-[13px]"
								>{t(`label_${d.label}`)}{#if exp && !exp.warn}
									· {exp.text}{/if}</span
							>
						</span>
						{#if exp?.warn}<Pill tone={exp.warn}>{exp.text}</Pill>{/if}
					</a>
					{#if mayEdit || mayDetach}
						<div class="pe-2">
							<Menu
								label={t('options_for', { name: d.name })}
								title={d.name}
								cancelLabel={t('cancel')}
								items={itemsOf(d)}
							>
								{#snippet trigger({ attrs })}
									<IconButton label={t('options_for', { name: d.name })} {...attrs}
										><Ellipsis class="size-5" /></IconButton
									>
								{/snippet}
							</Menu>
						</div>
					{/if}
				</div>
			{/each}
		</Card>
	{/if}
</Section>
