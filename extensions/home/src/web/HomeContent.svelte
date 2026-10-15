<script lang="ts">
	import { Button } from '@famos/ui/button';
	import {
		Card,
		Dialog,
		EmptyLine,
		type MenuItem,
		PageHeader,
		RecordHeader,
		Row,
		Section,
		SidePanel,
		wide,
	} from '@famos/ui/famos';
	import Slot from '@famos/ui/slot';
	import {
		ArrowLeft,
		Archive,
		ChevronRight,
		House,
		Pencil,
		Plus,
		Refrigerator,
		Zap,
	} from '@lucide/svelte';
	import {
		HOME_AUDIENCE,
		HOME_KIND,
		HOME_PRESETS,
		type Home,
		type Item,
		type ItemPresetId,
		type Service,
		homeUrl,
		ITEM_PRESETS,
	} from '../contract/index.js';
	import {
		addItem,
		addService,
		archiveHome,
		loadHome,
		loadItems,
		loadServices,
		type Outcome,
		updateHome,
	} from './data.js';
	import {
		emptyHome,
		emptyItem,
		emptyService,
		freshPicks,
		fromHome,
		type HomeFormValue,
		type ItemFormValue,
		type PresetPicks,
		type ServiceFormValue,
		scheduleFor,
		toHomeFields,
		toItemFields,
		toServiceFields,
		validateHome,
		validateItem,
		validateService,
	} from './form.js';
	import HomeForm from './HomeForm.svelte';
	import { useHome } from './i18n.js';
	import ItemForm from './ItemForm.svelte';
	import { openPath } from './nav.js';
	import RecordMenu from './RecordMenu.svelte';
	import ServiceForm from './ServiceForm.svelte';

	/**
	 * One home (`/home/:id`): its head (address, owner or tenant, Edit and the menu), the sections
	 * other extensions contribute to a record page (what needs doing, papers, costs), then its things
	 * and its services. Forms open in the side panel or the phone sheet.
	 */
	let { homeId }: { homeId: string } = $props();
	const { app, t } = useHome();

	let home = $state<Home | null>(null);
	let items = $state<Item[]>([]);
	let services = $state<Service[]>([]);
	let loaded = $state(false);
	let missing = $state(false);
	let loadError = $state(false);
	async function load() {
		const id = homeId;
		try {
			const loadedHome = await loadHome(id);
			const [loadedItems, loadedServices] = await Promise.all([loadItems(id), loadServices(id)]);
			if (id !== homeId) return;
			home = loadedHome;
			items = loadedItems;
			services = loadedServices;
			missing = false;
			loadError = false;
		} catch (error) {
			if (id !== homeId) return;
			home = null;
			// A home that was archived (or never existed) answers 404; anything else is a failure.
			const status = (error as { status?: number }).status;
			missing = status === 404 || status === 400;
			loadError = !missing;
		} finally {
			loaded = true;
		}
	}
	$effect(() => {
		void homeId;
		void load();
		return app.onEvent('home.', () => void load());
	});

	const canEdit = $derived(app.can('home.edit'));
	const report = (outcome: Outcome, message: string) => {
		if (outcome === 'drafted') app.sentForApproval();
		else app.toast(message);
	};
	const failed = () => app.toast(t('error'));
	const discard = $derived({
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	});

	// Editing the home: a panel, reflected as `?edit=1`.
	const editing = $derived(canEdit && app.query().get('edit') === '1');
	const setEditing = (on: boolean) => app.setQuery({ edit: on ? '1' : null }, { replace: !on });
	let form = $state<HomeFormValue>(emptyHome());
	let baseline = $state('');
	let showErrors = $state(false);
	let busy = $state(false);
	let formEl = $state<HTMLFormElement>();
	let formReady = false;
	const errors = $derived(showErrors ? validateHome(form) : {});
	const dirty = $derived(editing && JSON.stringify(form) !== baseline);
	$effect(() => {
		if (!editing) {
			formReady = false;
			return;
		}
		if (formReady || !home) return;
		form = fromHome(home);
		baseline = JSON.stringify(form);
		showErrors = false;
		formReady = true;
	});
	async function save(event: SubmitEvent) {
		event.preventDefault();
		showErrors = true;
		if (!home || Object.keys(validateHome(form)).length) return;
		busy = true;
		try {
			report(await updateHome(home.id, toHomeFields(form)), t('saved'));
			setEditing(false);
			await load();
		} catch {
			failed();
		} finally {
			busy = false;
		}
	}

	// Archiving asks first, in a dialog (the action sits in a menu).
	let archiving = $state(false);
	async function archive() {
		archiving = false;
		if (!home) return;
		try {
			const outcome = await archiveHome(home.id);
			report(outcome, t('archived'));
			if (outcome === 'applied') openPath('/home');
		} catch {
			failed();
		}
	}
	const menu = $derived<MenuItem[]>([
		{ id: 'edit', label: t('edit'), icon: pencil, onselect: () => setEditing(true) },
		{
			id: 'archive',
			label: t('archive_home'),
			icon: box,
			danger: true,
			onselect: () => (archiving = true),
		},
	]);

	// Adding a thing.
	let addingItem = $state(false);
	let itemForm = $state<ItemFormValue>(emptyItem());
	let itemPicks = $state<PresetPicks>(freshPicks(ITEM_PRESETS));
	let itemErrors = $state<Record<string, true>>({});
	let itemBaseline = $state('');
	let itemFormEl = $state<HTMLFormElement>();
	const itemDirty = $derived(addingItem && JSON.stringify([itemForm, itemPicks]) !== itemBaseline);
	function openItem() {
		itemForm = emptyItem();
		itemPicks = freshPicks(ITEM_PRESETS);
		itemErrors = {};
		itemBaseline = JSON.stringify([itemForm, itemPicks]);
		addingItem = true;
	}
	async function submitItem(event: SubmitEvent) {
		event.preventDefault();
		const found = validateItem(itemForm);
		const chosen = ITEM_PRESETS.filter((p) => itemPicks[p.id]?.on);
		for (const p of chosen) {
			if (!/^\d{4}-\d{2}-\d{2}$/.test(itemPicks[p.id]?.date ?? '')) found[`preset_${p.id}`] = true;
		}
		itemErrors = found;
		if (!home || Object.keys(found).length) return;
		busy = true;
		try {
			const { outcome, id } = await addItem({
				...toItemFields(itemForm),
				homeId: home.id,
				obligations: chosen.map((p) => ({
					preset: p.id as ItemPresetId,
					title: app.t(p.titleKey),
					dueDate: itemPicks[p.id]?.date ?? '',
					...scheduleFor(itemPicks, p.id),
				})),
			});
			report(outcome, t('saved'));
			addingItem = false;
			if (id) openPath(`/home/items/${id}`);
			else await load();
		} catch {
			failed();
		} finally {
			busy = false;
		}
	}

	// Adding a service.
	let addingService = $state(false);
	let serviceForm = $state<ServiceFormValue>(emptyService());
	let serviceShowErrors = $state(false);
	let serviceBaseline = $state('');
	let serviceFormEl = $state<HTMLFormElement>();
	const serviceErrors = $derived(serviceShowErrors ? validateService(serviceForm) : {});
	const serviceDirty = $derived(addingService && JSON.stringify(serviceForm) !== serviceBaseline);
	function openService() {
		serviceForm = emptyService();
		serviceShowErrors = false;
		serviceBaseline = JSON.stringify(serviceForm);
		addingService = true;
	}
	async function submitService(event: SubmitEvent) {
		event.preventDefault();
		serviceShowErrors = true;
		if (!home || Object.keys(validateService(serviceForm)).length) return;
		busy = true;
		try {
			const { outcome, id } = await addService({
				...toServiceFields(serviceForm),
				homeId: home.id,
			});
			report(outcome, t('saved'));
			addingService = false;
			if (id) openPath(`/home/services/${id}`);
			else await load();
		} catch {
			failed();
		} finally {
			busy = false;
		}
	}

	const itemSubtitle = (i: Item) =>
		[i.room, [i.brand, i.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
	const facts = $derived(home ? [t(`tenure_${home.tenure}`), home.address.split('\n')[0]] : []);
</script>

{#snippet pencil()}<Pencil class="size-4" />{/snippet}
{#snippet box()}<Archive class="size-4" />{/snippet}

{#snippet actionButtons()}
	{#if canEdit && home}
		<Button variant="outline" onclick={() => setEditing(true)}
			><Pencil class="size-4" aria-hidden="true" />{t('edit')}</Button
		>
		<RecordMenu
			name={home.name}
			label={t('options_for', { name: home.name })}
			cancelLabel={t('cancel')}
			items={menu}
		/>
	{/if}
{/snippet}

<div class="mb-3 flex items-center gap-2 lg:hidden">
	<Button variant="ghost" size="icon-sm" href="/home" aria-label={t('back')}
		><ArrowLeft class="size-5" aria-hidden="true" /></Button
	>
	{#if !wide.current}
		<span class="ms-auto flex items-center gap-2">{@render actionButtons()}</span>
	{/if}
</div>

{#if loadError}
	<p class="text-attention font-semibold" role="alert">{t('error')}</p>
{:else if missing}
	<PageHeader title={t('not_found')} />
{:else if home}
	<RecordHeader
		name={home.name}
		recordId={home.id}
		{facts}
		actions={wide.current ? actionButtons : undefined}
	>
		{#snippet icon()}<House />{/snippet}
	</RecordHeader>

	<div class="grid gap-7">
		{#if home.address.includes('\n') || home.notes}
			<div class="text-ink-soft grid max-w-prose gap-1">
				{#if home.address.includes('\n')}<p class="break-words whitespace-pre-line">
						{home.address}
					</p>{/if}
				{#if home.notes}<p class="break-words">{home.notes}</p>{/if}
			</div>
		{/if}

		<Slot
			name="record.section"
			props={{
				recordId: home.id,
				recordKind: HOME_KIND,
				recordName: home.name,
				recordUrl: homeUrl(home.id),
				audience: HOME_AUDIENCE,
				presets: HOME_PRESETS,
			}}
		/>

		{#snippet addItemAction()}
			{#if canEdit}
				<Button variant="ghost" size="sm" onclick={openItem}
					><Plus class="size-[15px]" aria-hidden="true" />{t('add_item')}</Button
				>
			{/if}
		{/snippet}
		<Section
			label={t('items_title')}
			count={items.length > 0 ? items.length : undefined}
			actions={addItemAction}
		>
			{#if loaded && items.length === 0}
				<EmptyLine text={t('items_empty')}>
					{#snippet icon()}<Refrigerator />{/snippet}
				</EmptyLine>
			{:else}
				<Card rows role="list">
					{#each items as i (i.id)}
						<div role="listitem">
							<Row title={i.name} meta={itemSubtitle(i) || undefined} href="/home/items/{i.id}">
								{#snippet lead()}
									<span class="bg-idle grid size-9 place-items-center rounded-full"
										><Refrigerator class="size-[18px]" aria-hidden="true" /></span
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

		{#snippet addServiceAction()}
			{#if canEdit}
				<Button variant="ghost" size="sm" onclick={openService}
					><Plus class="size-[15px]" aria-hidden="true" />{t('add_service')}</Button
				>
			{/if}
		{/snippet}
		<Section
			label={t('services_title')}
			count={services.length > 0 ? services.length : undefined}
			actions={addServiceAction}
		>
			{#if loaded && services.length === 0}
				<EmptyLine text={t('services_empty')}>
					{#snippet icon()}<Zap />{/snippet}
				</EmptyLine>
			{:else}
				<Card rows role="list">
					{#each services as s (s.id)}
						<div role="listitem">
							<Row
								title={s.provider}
								meta={[
									t(`service_kind_${s.kind}`),
									s.dueDay ? t('due_day_short', { day: s.dueDay }) : '',
								]
									.filter(Boolean)
									.join(' · ')}
								href="/home/services/{s.id}"
							>
								{#snippet lead()}
									<span class="bg-idle grid size-9 place-items-center rounded-full"
										><Zap class="size-[18px]" aria-hidden="true" /></span
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
	</div>
{/if}

<SidePanel
	open={editing}
	title={t('home_form_title')}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={t('save')}
	saveDisabled={busy}
	onsave={() => formEl?.requestSubmit()}
	{dirty}
	{discard}
	onclose={() => setEditing(false)}
>
	<form bind:this={formEl} onsubmit={save} aria-label={t('home_form_title')}>
		<HomeForm bind:value={form} {errors} idPrefix="edit-home" />
	</form>
</SidePanel>

<SidePanel
	open={addingItem}
	title={t('item_form_title')}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={t('save')}
	saveDisabled={busy}
	onsave={() => itemFormEl?.requestSubmit()}
	dirty={itemDirty}
	{discard}
	onclose={() => (addingItem = false)}
>
	<form bind:this={itemFormEl} onsubmit={submitItem} aria-label={t('item_form_title')}>
		<ItemForm
			bind:value={itemForm}
			bind:picks={itemPicks}
			errors={itemErrors}
			idPrefix="new-item"
		/>
	</form>
</SidePanel>

<SidePanel
	open={addingService}
	title={t('service_form_title')}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={t('save')}
	saveDisabled={busy}
	onsave={() => serviceFormEl?.requestSubmit()}
	dirty={serviceDirty}
	{discard}
	onclose={() => (addingService = false)}
>
	<form bind:this={serviceFormEl} onsubmit={submitService} aria-label={t('service_form_title')}>
		<ServiceForm bind:value={serviceForm} errors={serviceErrors} idPrefix="new-service" />
	</form>
</SidePanel>

<Dialog
	open={archiving}
	title={t('archive_title', { name: home?.name ?? '' })}
	description={t('archive_home_hint')}
	onclose={() => (archiving = false)}
>
	{#snippet actions()}
		<Button variant="ghost" data-autofocus onclick={() => (archiving = false)}>{t('cancel')}</Button
		>
		<Button variant="danger" data-armed="true" onclick={archive}>{t('archive_do')}</Button>
	{/snippet}
</Dialog>
