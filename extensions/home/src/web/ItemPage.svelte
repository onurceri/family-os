<script lang="ts">
	import { compareDates, formatDate, todayIn } from '@famos/time';
	import { Button } from '@famos/ui/button';
	import {
		Dialog,
		editLabel,
		focusFirstInvalid,
		type MenuItem,
		openPath,
		Page,
		PageHeader,
		RecordHeader,
		RecordMenu,
		removeLabels,
		SidePanel,
		wide,
	} from '@famos/ui/famos';
	import Slot from '@famos/ui/slot';
	import { ArrowLeft, Archive, Pencil, Refrigerator } from '@lucide/svelte';
	import {
		HOME_AUDIENCE,
		ITEM_KIND,
		ITEM_PRESETS,
		type Home,
		type Item,
		itemUrl,
	} from '../contract/index.js';
	import { archiveItem, loadHome, loadItem, type Outcome, updateItem } from './data.js';
	import { emptyItem, fromItem, type ItemFormValue, toItemFields, validateItem } from './form.js';
	import { useHome } from './i18n.js';
	import ItemForm from './ItemForm.svelte';

	/**
	 * One thing's page (`/home/items/:id`): its head (room, brand, warranty), then what needs doing
	 * (a warranty end date appears there by itself) and its papers (the receipt).
	 */
	let { params }: { params: Record<string, string> } = $props();
	const { app, t } = useHome();

	const itemId = $derived(params.id ?? '');
	let item = $state<Item | null>(null);
	let home = $state<Home | null>(null);
	let missing = $state(false);
	let loadError = $state(false);
	async function load() {
		// A slower answer for the record chosen before must not replace this one.
		const id = itemId;
		try {
			const loaded = await loadItem(id);
			const loadedHome = await loadHome(loaded.homeId).catch(() => null);
			if (id !== itemId) return;
			item = loaded;
			home = loadedHome;
			missing = false;
			loadError = false;
		} catch (error) {
			if (id !== itemId) return;
			item = null;
			const status = (error as { status?: number }).status;
			missing = status === 404 || status === 400;
			loadError = !missing;
		}
	}
	$effect(() => {
		void itemId;
		void load();
		return app.onEvent('home.', () => void load());
	});

	// Also for people who may only suggest a change: theirs waits for approval.
	const mayEdit = $derived(app.access('home.updateItem') !== 'no');
	// "Suggest a change" when the change would wait for approval.
	const editText = $derived(editLabel(app, 'home.updateItem', t('edit')));
	const mayArchive = $derived(app.access('home.archiveItem') !== 'no');
	// "Suggest removing" when archiving would wait for approval.
	const archiveText = (label: string) =>
		removeLabels(
			app,
			'home.archiveItem',
			{ label, confirmLabel: '' },
			item ? { id: item.id } : undefined,
		).label;
	const report = (outcome: Outcome, message: string) => {
		if (outcome === 'drafted') app.sentForApproval();
		else app.toast(message);
	};
	const dateOf = (d: string) =>
		formatDate(d, app.dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' });

	// Editing: a panel (a sheet on phones), reflected as `?edit=1`.
	const editing = $derived(mayEdit && app.query().get('edit') === '1');
	const setEditing = (on: boolean) => app.setQuery({ edit: on ? '1' : null }, { replace: !on });
	let form = $state<ItemFormValue>(emptyItem());
	let baseline = $state('');
	let showErrors = $state(false);
	let busy = $state(false);
	let formEl = $state<HTMLFormElement>();
	let formReady = false;
	const errors = $derived(showErrors ? validateItem(form) : {});
	const dirty = $derived(editing && JSON.stringify(form) !== baseline);
	$effect(() => {
		if (!editing) {
			formReady = false;
			return;
		}
		if (formReady || !item) return;
		form = fromItem(item);
		baseline = JSON.stringify(form);
		showErrors = false;
		formReady = true;
	});
	async function save(event: SubmitEvent) {
		event.preventDefault();
		showErrors = true;
		if (!item || Object.keys(validateItem(form)).length) {
			void focusFirstInvalid(event.currentTarget);
			return;
		}
		busy = true;
		try {
			report(
				await updateItem({ id: item.id as `home_item_${string}`, ...toItemFields(form) }),
				t('saved'),
			);
			setEditing(false);
			await load();
		} catch {
			app.toast(t('error'));
		} finally {
			busy = false;
		}
	}

	let archiving = $state(false);
	async function archive() {
		archiving = false;
		if (!item) return;
		try {
			const outcome = await archiveItem(item.id);
			report(outcome, t('item_archived'));
			if (outcome === 'applied') openPath(home ? `/home/${home.id}` : '/home');
		} catch {
			app.toast(t('error'));
		}
	}
	const menu = $derived<MenuItem[]>([
		...(mayEdit
			? [{ id: 'edit', label: editText, icon: pencil, onselect: () => setEditing(true) }]
			: []),
		...(mayArchive
			? [
					{
						id: 'archive',
						label: archiveText(t('archive_item')),
						icon: box,
						danger: true,
						onselect: () => (archiving = true),
					},
				]
			: []),
	]);

	// A warranty that has ended is a plain fact of the thing, not something late.
	const warrantyFact = (until: string) =>
		compareDates(until, todayIn(app.timeZone(), Date.now())) < 0
			? t('warranty_ended_on', { date: dateOf(until) })
			: `${t('field_warranty_until')} ${dateOf(until)}`;

	const facts = $derived(
		item
			? [
					item.room,
					[item.brand, item.model].filter(Boolean).join(' '),
					item.purchasedOn ? `${t('field_purchased_on')} ${dateOf(item.purchasedOn)}` : null,
					item.warrantyUntil ? warrantyFact(item.warrantyUntil) : null,
					item.serial ? `${t('field_serial')} ${item.serial}` : null,
				]
			: [],
	);
</script>

{#snippet pencil()}<Pencil class="size-4" />{/snippet}
{#snippet box()}<Archive class="size-4" />{/snippet}

{#snippet actionButtons()}
	{#if item}
		{#if mayEdit}
			<Button variant="outline" onclick={() => setEditing(true)}
				><Pencil class="size-4" aria-hidden="true" />{editText}</Button
			>
		{/if}
		{#if menu.length > 0}
			<RecordMenu
				name={item.name}
				label={t('options_for', { name: item.name })}
				cancelLabel={t('cancel')}
				items={menu}
			/>
		{/if}
	{/if}
{/snippet}

<Page template="record">
	<div class="mb-3 flex items-center gap-2">
		<Button variant="ghost" size="sm" href={home ? `/home/${home.id}` : '/home'} class="-ms-2"
			><ArrowLeft class="size-4" aria-hidden="true" />{home ? home.name : t('back')}</Button
		>
		{#if !wide.current}
			<span class="ms-auto flex items-center gap-2">{@render actionButtons()}</span>
		{/if}
	</div>

	{#if loadError}
		<p class="text-attention font-semibold" role="alert">{t('error')}</p>
	{:else if missing}
		<PageHeader title={t('item_not_found')} />
	{:else if item}
		<RecordHeader
			name={item.name}
			recordId={item.id}
			{facts}
			actions={wide.current ? actionButtons : undefined}
		>
			{#snippet icon()}<Refrigerator />{/snippet}
		</RecordHeader>

		<div class="grid gap-7">
			{#if item.notes}<p class="text-ink-soft max-w-prose break-words">{item.notes}</p>{/if}

			<Slot
				name="record.section"
				props={{
					recordId: item.id,
					recordKind: ITEM_KIND,
					recordName: item.name,
					recordUrl: itemUrl(item.id),
					audience: HOME_AUDIENCE,
					presets: ITEM_PRESETS,
				}}
			/>
		</div>
	{/if}
</Page>

<SidePanel
	approval={app.approval('home.updateItem')}
	open={editing}
	title={t('item_form_title')}
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
	onclose={() => setEditing(false)}
>
	<form bind:this={formEl} onsubmit={save} aria-label={t('item_form_title')}>
		<ItemForm bind:value={form} {errors} idPrefix="edit-item" />
	</form>
</SidePanel>

<Dialog
	open={archiving}
	title={t('archive_title', { name: item?.name ?? '' })}
	description={t('archive_item_hint')}
	onclose={() => (archiving = false)}
>
	{#snippet actions()}
		<Button variant="ghost" data-autofocus onclick={() => (archiving = false)}>{t('cancel')}</Button
		>
		<Button variant="danger" data-armed="true" onclick={archive}
			>{archiveText(t('archive_do'))}</Button
		>
	{/snippet}
</Dialog>
