<script lang="ts">
	import { isApiError } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import {
		Card,
		ConfirmButton,
		FieldError,
		fieldAria,
		Row,
		Section,
		SidePanel,
		SwitchRow,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { ArrowDown, ArrowUp } from '@lucide/svelte';
	import { onDestroy, onMount } from 'svelte';
	import {
		type Entities,
		EntityIdSchema,
		type Item,
		LabelSchema,
		MAX_ITEMS,
		operationsOf,
		type Values,
	} from '../contract/index.js';
	import Controls from './Controls.svelte';
	import {
		addItem,
		findEntities,
		loadItems,
		loadValues,
		moveItem,
		removeItem,
		renameItem,
		setItemControl,
	} from './data.js';
	import { useHomeAssistant } from './i18n.js';
	import { sayValue } from './say.js';
	import SwitchHistoryList from './SwitchHistoryList.svelte';
	import { createSwitcher } from './switching.svelte.js';

	/**
	 * Settings, Home Assistant, "What to show": the things the family shows on Today and on family
	 * displays, each with a short name of its own. Tap a row to rename, move or remove it, or to
	 * choose whether it can be switched from FamilyOS; Add searches what Home Assistant has.
	 */
	let {
		full = $bindable(false),
	}: {
		/** The list has the most it can hold: the page disables Add and says why. */
		full?: boolean;
	} = $props();
	const { app, t } = useHomeAssistant();

	let items = $state<Item[]>([]);
	let values = $state<Values | null>(null);

	async function load(): Promise<Values | null> {
		try {
			[items, values] = await Promise.all([loadItems(), loadValues()]);
		} catch {
			// Keep what is shown; an event or the next visit loads it again.
		}
		return values;
	}
	const maySwitch = $derived(app.access('homeassistant.switch') !== 'no');
	const switcher = createSwitcher({
		app,
		t,
		reload: load,
		shown: () => values?.items ?? [],
	});
	let off: (() => void) | undefined;
	onMount(() => {
		void load();
		off = app.onEvent('homeassistant.', () => void load());
	});
	onDestroy(() => {
		off?.();
		switcher.stop();
	});

	$effect(() => {
		full = items.length >= MAX_ITEMS;
	});

	const live = (id: string) => values?.items.find((v) => v.id === id) ?? null;
	/** The entity's own name and its value now, as the row's second line. */
	function meta(item: Item): string {
		const found = live(item.id);
		const value = switcher.busy(item.id)
			? t('switching')
			: sayValue(app, t, found?.value ?? { kind: 'unavailable' }).text;
		return found?.name ? `${found.name} · ${value}` : `${item.entityId} · ${value}`;
	}

	// Adding
	let adding = $state(false);
	let query = $state('');
	let found = $state<Entities | null>(null);
	let searching = $state(false);
	let picked = $state<{ entityId: string; name: string } | null>(null);
	let typedId = $state('');
	let newLabel = $state('');
	let busy = $state(false);
	let failed = $state<'show_error' | 'show_duplicate' | null>(null);
	let showErrors = $state(false);
	let addForm = $state<HTMLFormElement>();

	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let searchRun = 0;
	async function search() {
		const run = ++searchRun;
		searching = true;
		try {
			const result = await findEntities(query.trim());
			if (run === searchRun) found = result;
		} catch {
			if (run === searchRun) found = { entities: [], status: 'unavailable', more: false };
		} finally {
			if (run === searchRun) searching = false;
		}
	}
	function typing() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => void search(), 250);
	}
	onDestroy(() => clearTimeout(searchTimer));

	export function add() {
		query = '';
		found = null;
		picked = null;
		typedId = '';
		newLabel = '';
		failed = null;
		showErrors = false;
		adding = true;
		void search();
	}

	function pick(entityId: string, name: string) {
		picked = { entityId, name };
		newLabel = name.slice(0, 40);
	}

	/** What will be added: a picked entity, or an id typed when the home is too big to list. */
	const chosenId = $derived(
		picked?.entityId ?? (found?.status === 'ok' || !found ? '' : typedId.trim()),
	);
	const addErrors = $derived({
		...(EntityIdSchema.safeParse(chosenId).success ? {} : { id: 'homeassistant:show_id_error' }),
		...(LabelSchema.safeParse(newLabel).success ? {} : { label: 'homeassistant:show_label_error' }),
	} as Record<string, string>);

	function reason(error: unknown): 'show_error' | 'show_duplicate' {
		return isApiError(error) && error.code === 'conflict' ? 'show_duplicate' : 'show_error';
	}

	async function submitAdd(event: SubmitEvent) {
		event.preventDefault();
		showErrors = true;
		if (Object.keys(addErrors).length) return;
		busy = true;
		failed = null;
		try {
			await addItem({ entityId: chosenId, label: newLabel.trim() });
			app.toast(t('show_added'));
			adding = false;
			await load();
		} catch (error) {
			failed = reason(error);
		} finally {
			busy = false;
		}
	}

	// Editing
	let editing = $state<Item | null>(null);
	let editLabel = $state('');
	let editControl = $state(false);
	let editConfirm = $state(false);
	let editForm = $state<HTMLFormElement>();
	const editError = $derived(
		LabelSchema.safeParse(editLabel).success ? undefined : 'homeassistant:show_label_error',
	);
	const index = $derived(editing ? items.findIndex((i) => i.id === editing?.id) : -1);
	/** Only what FamilyOS can switch offers the choice. */
	const switchable = $derived(editing ? operationsOf(editing.entityId).length > 0 : false);
	const editDirty = $derived(
		editing !== null &&
			(editLabel !== editing.label ||
				editControl !== editing.control ||
				editConfirm !== editing.confirm),
	);

	function open(item: Item) {
		editing = item;
		editLabel = item.label;
		editControl = item.control;
		editConfirm = item.confirm;
		failed = null;
		showErrors = false;
	}

	async function submitEdit(event: SubmitEvent) {
		event.preventDefault();
		showErrors = true;
		if (!editing || editError) return;
		busy = true;
		failed = null;
		try {
			if (editLabel.trim() !== editing.label)
				await renameItem({ id: editing.id, label: editLabel.trim() });
			if (editControl !== editing.control || editConfirm !== editing.confirm)
				await setItemControl({ id: editing.id, control: editControl, confirm: editConfirm });
			app.toast(t('show_saved'));
			editing = null;
			await load();
		} catch (error) {
			failed = reason(error);
		} finally {
			busy = false;
		}
	}

	async function move(by: -1 | 1) {
		if (!editing || index < 0) return;
		try {
			await moveItem(editing.id, index + by);
			await load();
		} catch {
			failed = 'show_error';
		}
	}

	async function remove() {
		if (!editing) return;
		try {
			await removeItem(editing.id);
			app.toast(t('show_removed'));
			editing = null;
			await load();
		} catch {
			failed = 'show_error';
		}
	}

	const discard = $derived({
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	});
</script>

<Section label={t('show_label')} count={items.length > 0 ? items.length : undefined}>
	{#if items.length === 0}
		<Card variant="quiet" pad>
			<p class="text-ink-soft max-w-prose text-sm">{t('show_empty')}</p>
		</Card>
	{:else}
		<Card rows>
			{#each items as item (item.id)}
				{@const shown = live(item.id)}
				{#if maySwitch && item.control && shown}
					<!-- The text opens the item; only the switch or the buttons act. -->
					<div class="flex items-center gap-2 pe-3">
						<div class="min-w-0 flex-1">
							<Row title={item.label} meta={meta(item)} onclick={() => open(item)} />
						</div>
						<Controls
							item={shown}
							busy={switcher.busy(item.id)}
							onswitch={(op) => void switcher.run(shown, op)}
						/>
					</div>
				{:else}
					<Row title={item.label} meta={meta(item)} onclick={() => open(item)} />
				{/if}
			{/each}
		</Card>
	{/if}
	{#if full}<p class="text-ink-soft text-[13px]">{t('show_limit', { count: MAX_ITEMS })}</p>{/if}
</Section>

<SidePanel
	open={adding}
	title={t('show_add_title')}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={t('show_save')}
	saveDisabled={busy || !chosenId}
	onsave={() => addForm?.requestSubmit()}
	onclose={() => (adding = false)}
	dirty={adding && newLabel !== '' && picked !== null}
	{discard}
>
	<form
		class="grid gap-5"
		bind:this={addForm}
		onsubmit={submitAdd}
		aria-label={t('show_add_title')}
	>
		{#if picked}
			<div class="grid gap-1.5">
				<Row title={picked.name} meta={picked.entityId} />
				<Button
					variant="ghost"
					type="button"
					onclick={() => {
						picked = null;
						typedId = '';
					}}>{t('show_other')}</Button
				>
			</div>
		{:else}
			<div class="grid gap-1.5">
				<Label for="ha-search">{t('show_search')}</Label>
				<Input
					id="ha-search"
					bind:value={query}
					oninput={typing}
					maxlength={80}
					autocomplete="off"
					autocapitalize="off"
					spellcheck={false}
				/>
				<p class="text-ink-soft text-[13px]">{t('show_search_hint')}</p>
			</div>
			{#if found?.status === 'too_many'}
				<p class="text-ink-soft text-sm">{t('show_too_many')}</p>
			{:else if found?.status === 'unavailable' || found?.status === 'not_connected'}
				<p class="text-ink-soft text-sm">{t('show_unavailable')}</p>
			{/if}
			{#if found && found.status !== 'ok'}
				<div class="grid gap-1.5">
					<Label for="ha-entity">{t('show_id_field')}</Label>
					<Input
						id="ha-entity"
						bind:value={typedId}
						maxlength={200}
						autocomplete="off"
						autocapitalize="off"
						spellcheck={false}
						placeholder="sensor.kitchen_temperature"
						{...fieldAria(showErrors ? addErrors.id : undefined, 'ha-entity')}
					/>
					<FieldError for="ha-entity" error={showErrors ? addErrors.id : undefined} />
				</div>
			{:else if found && found.entities.length === 0 && !searching}
				<p class="text-ink-soft text-sm">{t('show_none_found')}</p>
			{:else if found}
				<Card rows>
					{#each found.entities.filter((e) => !items.some((i) => i.entityId === e.entityId)) as entity (entity.entityId)}
						<Row
							title={entity.name}
							meta={`${entity.entityId} · ${sayValue(app, t, entity.value).text}`}
							onclick={() => pick(entity.entityId, entity.name)}
						/>
					{/each}
				</Card>
				{#if found.more}
					<p class="text-ink-soft text-[13px]">{t('show_more_matches')}</p>
				{/if}
			{/if}
		{/if}
		{#if picked || (found && found.status !== 'ok' && typedId.trim())}
			<div class="grid gap-1.5">
				<Label for="ha-label">{t('show_label_field')}</Label>
				<Input
					id="ha-label"
					bind:value={newLabel}
					maxlength={40}
					autocomplete="off"
					{...fieldAria(showErrors ? addErrors.label : undefined, 'ha-label')}
				/>
				<FieldError for="ha-label" error={showErrors ? addErrors.label : undefined} />
				<p class="text-ink-soft text-[13px]">{t('show_label_hint')}</p>
			</div>
		{/if}
		{#if failed}
			<p class="text-attention text-sm font-semibold" role="alert">{t(failed)}</p>
		{/if}
	</form>
</SidePanel>

<SidePanel
	open={editing !== null}
	title={t('show_edit_title')}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={t('show_save')}
	saveDisabled={busy}
	onsave={() => editForm?.requestSubmit()}
	onclose={() => (editing = null)}
	dirty={editDirty}
	{discard}
>
	{#snippet danger()}
		<ConfirmButton
			label={t('show_remove')}
			confirmLabel={t('show_remove_confirm')}
			onconfirm={remove}
		/>
	{/snippet}
	{#if editing}
		<form
			class="grid gap-5"
			bind:this={editForm}
			onsubmit={submitEdit}
			aria-label={t('show_edit_title')}
		>
			<div class="grid gap-1.5">
				<Label for="ha-edit-label">{t('show_label_field')}</Label>
				<Input
					id="ha-edit-label"
					bind:value={editLabel}
					maxlength={40}
					autocomplete="off"
					{...fieldAria(showErrors ? editError : undefined, 'ha-edit-label')}
				/>
				<FieldError for="ha-edit-label" error={showErrors ? editError : undefined} />
				<p class="text-ink-soft text-[13px]">{editing.entityId}</p>
			</div>
			{#if switchable}
				<div class="grid gap-1.5">
					<Card rows>
						<SwitchRow id="ha-edit-control" label={t('control_label')} bind:checked={editControl} />
						{#if editControl}
							<SwitchRow
								id="ha-edit-confirm"
								label={t('confirm_label')}
								hint={t('confirm_hint')}
								bind:checked={editConfirm}
							/>
						{/if}
					</Card>
					<p class="text-ink-soft text-[13px]">
						{t('control_hint', { capability: t('cap_control') })}
					</p>
				</div>
			{/if}
			{#if switchable}
				{#key editing.id}
					<SwitchHistoryList itemId={editing.id} limit={5} framed={false} />
				{/key}
			{/if}
			<div class="flex flex-wrap gap-2">
				<Button variant="outline" type="button" disabled={index <= 0} onclick={() => move(-1)}
					><ArrowUp class="size-4" aria-hidden="true" />{t('show_move_up')}</Button
				>
				<Button
					variant="outline"
					type="button"
					disabled={index < 0 || index >= items.length - 1}
					onclick={() => move(1)}
					><ArrowDown class="size-4" aria-hidden="true" />{t('show_move_down')}</Button
				>
			</div>
			{#if failed}
				<p class="text-attention text-sm font-semibold" role="alert">{t(failed)}</p>
			{/if}
		</form>
	{/if}
</SidePanel>
