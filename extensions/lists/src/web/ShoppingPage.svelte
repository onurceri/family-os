<script lang="ts">
	import { isApiError } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import {
		ActionSheet,
		AwaitingMark,
		Chip,
		Composer,
		ConfirmButton,
		Dialog,
		EmptyArt,
		IconButton,
		lengthState,
		LimitCounter,
		Menu,
		type MenuItem,
		Page,
		SidePanel,
		wide,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { Check, ChevronRight, MoreHorizontal, Pencil, Plus, Trash2 } from '@lucide/svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import { slide } from 'svelte/transition';
	import {
		CATEGORIES,
		LIST_NAME_MAX,
		SHOPPING_QUANTITY_MAX,
		SHOPPING_TITLE_MAX,
		type Category,
		type ShoppingItem,
		type ShoppingList,
	} from '../contract/index.js';
	import {
		addItems,
		archiveList,
		checkItem,
		clearBought,
		createList,
		deleteItem,
		loadItems,
		loadLists,
		type Outcome,
		renameList,
		restoreItem,
		updateItem,
	} from './data.js';
	import { movedToHiddenCart } from './format.js';
	import { useLists } from './i18n.js';
	import ListsHeader from './ListsHeader.svelte';
	import { latestOnly } from './latest-only.js';
	import { longestTitle, parseQuickAdd } from './quick-add.js';

	/**
	 * The Shopping page, made for the shop: one hand, a phone. The lists as chips, a big add field
	 * (at the bottom above the tabs on a phone, within the thumb's reach; on top elsewhere), big
	 * rows to tick, and what is ticked slides into "In the cart" at the bottom (a column of its own
	 * on a wide page), with "Clear the cart".
	 */
	const { app, t } = useLists();

	let lists = $state<ShoppingList[]>([]);
	let selectedId = $state<string | null>(null);
	const list = $derived(lists.find((l) => l.id === selectedId) ?? lists[0] ?? null);
	let items = $state<ShoppingItem[]>([]);
	let loadError = $state(false);
	/** The items of the chosen list have been read once (an empty list is then really empty). */
	let itemsLoaded = $state(false);
	/** Optimistic check state by item id. */
	let pending = $state<Record<string, boolean>>({});

	// Changes kept on this device while offline: shown as if saved, marked "waiting".
	const queuedChecks = $derived(
		new Map(
			app
				.waiting()
				.filter((w) => w.actionId === 'lists.checkShoppingItem')
				.map((w) => {
					const input = w.input as { id: string; done: boolean };
					return [input.id, input.done] as const;
				}),
		),
	);
	const queuedAdds = $derived(
		app
			.waiting()
			.filter((w) => w.actionId === 'lists.addShoppingItems')
			.flatMap((w, n) => {
				const input = w.input as { listId?: string; items: { title: string; quantity?: string }[] };
				if (input.listId && input.listId !== list?.id) return [];
				return input.items.map((item, i) => ({ ...item, id: `queued-${n}-${i}` }));
			}),
	);

	async function refreshLists() {
		try {
			lists = await loadLists();
			loadError = false;
		} catch {
			loadError = true;
		}
	}
	const itemReads = latestOnly();
	async function refreshItems(listId: string) {
		const stillCurrent = itemReads.begin();
		// An answer that was overtaken, or is for a list no longer shown, must not replace the items.
		const usable = () => stillCurrent() && list?.id === listId;
		try {
			const loaded = await loadItems(listId);
			if (usable()) items = loaded;
		} catch {
			if (usable()) loadError = true;
		} finally {
			if (usable()) itemsLoaded = true;
		}
	}

	$effect(() => {
		void app.offline(); // load again when the connection is back
		void refreshLists();
		return app.onEvent('lists.shopping.', () => void refreshLists());
	});
	$effect(() => {
		const id = list?.id;
		if (!id) return;
		void app.offline();
		void refreshItems(id);
		return app.onEvent('lists.shopping.', (_name, payload) => {
			if ((payload as { listId?: string } | null)?.listId === id) void refreshItems(id);
		});
	});

	// When waiting changes were sent (the queue got shorter), read the list again.
	let waitingBefore = 0;
	$effect(() => {
		const n = app.waiting().length;
		if (n < waitingBefore && list) void refreshItems(list.id);
		waitingBefore = n;
	});

	const isDone = (item: ShoppingItem) =>
		pending[item.id] ?? queuedChecks.get(item.id) ?? item.doneAt !== null;
	const isWaiting = (item: ShoppingItem) => queuedChecks.has(item.id);
	const open = $derived(items.filter((i) => i.doneAt === null));
	const bought = $derived(items.filter((i) => i.doneAt !== null));
	const sections = $derived(
		CATEGORIES.map((category) => ({
			category,
			items: open.filter((i) => i.category === category),
		})).filter((s) => s.items.length),
	);
	const catLabel = (c: Category) => t(`cat_${c}`);
	const toGet = $derived(open.length + queuedAdds.length);

	// A ticked item slides out of the list and into the cart (150 ms; none with reduced motion).
	// Only the item that was just ticked moves: a list that loads or changes does not animate.
	const moving = new Set<string>();
	function move(node: Element, { id }: { id: string }) {
		return moving.has(id) && !prefersReducedMotion.current
			? slide(node, { duration: 150 })
			: { duration: 0 };
	}

	// On a phone the add field sits above the tab bar: the toast rises above it, and what is
	// scrolled into view stops above it too.
	$effect(() => {
		const root = document.documentElement;
		root.style.setProperty('--fab-clearance', 'calc(var(--fab-bottom, 0px) - 12px)');
		root.style.setProperty(
			'scroll-padding-bottom',
			'calc(var(--fab-bottom, 0px) + 6rem + env(safe-area-inset-bottom))',
		);
		return () => {
			root.style.removeProperty('--fab-clearance');
			root.style.removeProperty('scroll-padding-bottom');
		};
	});

	function report(outcome: Outcome, message?: string) {
		if (outcome === 'queued') app.toast(t('queued_toast'));
		else if (outcome === 'drafted') app.sentForApproval();
		else if (message) app.toast(message);
	}

	async function toggle(item: ShoppingItem, to?: boolean) {
		const next = to ?? !isDone(item);
		moving.add(item.id);
		setTimeout(() => moving.delete(item.id), 1000);
		pending[item.id] = next;
		try {
			const outcome = await checkItem(
				app,
				item.id,
				next,
				t(next ? 'label_check' : 'label_uncheck', { title: item.title }),
			);
			report(outcome);
			// With the cart folded away the item seems to vanish, so say where it went.
			if (movedToHiddenCart(next, outcome, cartOpen))
				app.toast(t('in_cart'), { label: t('undo'), run: () => void toggle(item, false) });
			if (list) await refreshItems(list.id);
		} catch {
			app.toast(t('error'));
		} finally {
			delete pending[item.id];
		}
	}

	// Quick add: "2 kg tomatoes, bread" → two items.
	let quick = $state('');
	// False when it failed, so the composer gives the typing back.
	async function quickAdd(text: string): Promise<boolean> {
		const parsed = parseQuickAdd(text, t('quantity_units').split(','));
		if (!parsed.length || !list) return false;
		// Nothing is cut: an item that is too long stays in the field with a message.
		if (parsed.some((p) => itemTooLong(p.title, p.quantity))) {
			app.toast(t('too_long_item'));
			return false;
		}
		try {
			report(
				await addItems(
					app,
					{ listId: list.id, items: parsed },
					t('label_add', { titles: parsed.map((p) => p.title).join(', ') }),
				),
			);
			return true;
		} catch {
			app.toast(t('error'));
			return false;
		}
	}

	// Item editor: a side panel, or a sheet on phones; opened from the row's menu.
	let editing = $state<{ id: string; title: string; quantity: string; category: Category } | null>(
		null,
	);
	let snapshot = '';
	const dirty = $derived(editing !== null && JSON.stringify(editing) !== snapshot);
	let editForm = $state<HTMLFormElement | null>(null);
	let showEditErrors = $state(false);
	const itemTooLong = (title: string, quantity: string | null | undefined) =>
		title.trim().length > SHOPPING_TITLE_MAX ||
		(quantity ?? '').trim().length > SHOPPING_QUANTITY_MAX;
	function edit(item: ShoppingItem) {
		showEditErrors = false;
		editing = {
			id: item.id,
			title: item.title,
			quantity: item.quantity ?? '',
			category: item.category,
		};
		snapshot = JSON.stringify(editing);
	}
	async function saveEdit(event: SubmitEvent) {
		event.preventDefault();
		if (!editing || !editing.title.trim()) return;
		showEditErrors = true;
		if (itemTooLong(editing.title, editing.quantity)) return;
		try {
			report(
				await updateItem(editing.id, {
					title: editing.title.trim(),
					quantity: editing.quantity.trim() || null,
					category: editing.category,
				}),
			);
			editing = null;
		} catch {
			app.toast(t('error'));
		}
	}
	async function removeItem(id: string) {
		try {
			report(await deleteItem(id), t('deleted'));
			editing = null;
		} catch {
			app.toast(t('error'));
		}
	}
	/** Delete from the row's menu: gone at once, with Undo (puts it back). */
	async function removeWithUndo(item: ShoppingItem) {
		const listId = list?.id;
		try {
			const outcome = await deleteItem(item.id);
			if (outcome !== 'applied') return report(outcome, t('deleted'));
			app.toast(
				t('deleted'),
				listId
					? {
							label: t('undo'),
							run: () => void restoreItem(item.id).catch(() => app.toast(t('error'))),
						}
					: undefined,
			);
		} catch {
			app.toast(t('error'));
		}
	}
	const rowItems = (item: ShoppingItem): MenuItem[] => [
		{ id: 'edit', label: t('edit_item'), icon: pencilIcon, onselect: () => edit(item) },
		{
			id: 'delete',
			label: t('delete_item'),
			icon: trashIcon,
			danger: true,
			onselect: () => void removeWithUndo(item),
		},
	];
	let sheetFor = $state<ShoppingItem | null>(null);
	let sheetOpen = $state(false);
	let showBought = $state(false);

	// From 40 rem of width the cart is a column beside the list, open; narrower it is folded under
	// the list. Only with something in it: never a half-empty column.
	let width = $state(0);
	const twoColumns = $derived(width >= 640 && bought.length > 0);
	const cartOpen = $derived(twoColumns || showBought);

	// List management: "+" adds a list, the list's ⋯ renames or removes it. The name is typed in
	// place of the chips; removing asks first.
	let listForm = $state<{ mode: 'new' | 'rename'; name: string } | null>(null);
	let confirmRemove = $state(false);
	let listSheetOpen = $state(false);
	const listName = (l: ShoppingList) => l.name || t('default_list');
	const listItems = $derived<MenuItem[]>(
		list
			? [
					{
						id: 'rename',
						label: t('rename_list'),
						icon: pencilIcon,
						onselect: () => (listForm = { mode: 'rename', name: listName(list) }),
					},
					...(lists.length > 1
						? [
								{
									id: 'remove',
									label: t('remove_list'),
									icon: trashIcon,
									danger: true,
									onselect: () => (confirmRemove = true),
								},
							]
						: []),
				]
			: [],
	);
	function focusOnMount(node: HTMLInputElement) {
		node.focus();
		node.select();
	}
	async function saveList(event: SubmitEvent) {
		event.preventDefault();
		if (!listForm || !listForm.name.trim()) return;
		try {
			if (listForm.mode === 'new') {
				const { outcome, id } = await createList(listForm.name.trim());
				report(outcome);
				if (id) selectedId = id;
			} else if (list) {
				report(await renameList(list.id, listForm.name.trim()));
			}
			listForm = null;
		} catch (e) {
			const taken =
				isApiError(e) &&
				typeof e.details === 'object' &&
				e.details !== null &&
				'reason' in e.details &&
				e.details.reason === 'name_taken';
			app.toast(taken ? t('list_name_taken') : t('error'));
		}
	}
	async function removeList() {
		if (!list) return;
		try {
			report(await archiveList(list.id), t('deleted'));
			selectedId = null;
			listForm = null;
			confirmRemove = false;
		} catch {
			app.toast(t('error'));
		}
	}

	async function clear(listId: string) {
		try {
			report(await clearBought(listId));
			showBought = false;
		} catch {
			app.toast(t('error'));
		}
	}
</script>

{#snippet deleteItemButton()}
	<ConfirmButton
		label={t('delete')}
		confirmLabel={t('delete_confirm')}
		onconfirm={() => removeItem(editing?.id ?? '')}
	/>
{/snippet}
{#snippet pencilIcon()}<Pencil class="size-4" />{/snippet}
{#snippet trashIcon()}<Trash2 class="size-4" />{/snippet}

{#snippet itemRow(item: ShoppingItem)}
	{@const done = isDone(item)}
	<div class="flex min-h-[52px] items-center {done ? 'text-ink-soft' : 'text-ink'}">
		<button
			type="button"
			onclick={() => toggle(item)}
			aria-pressed={done}
			class="flex min-h-[52px] min-w-0 flex-1 items-center gap-3 py-2 ps-3 pe-2 text-start"
		>
			<span
				class="grid size-7 shrink-0 place-items-center rounded-full border-2 transition-colors motion-reduce:transition-none {done
					? 'bg-now text-on-color border-transparent'
					: 'border-ink-soft/55 text-transparent'}"
			>
				<Check class="size-4" strokeWidth={3} />
			</span>
			<span class="min-w-0 truncate text-base font-semibold {done ? 'line-through' : ''}"
				>{item.title}</span
			>
			{#if isWaiting(item)}
				<span class="text-ink-soft shrink-0 text-xs font-semibold" data-testid="waiting-mark"
					>{t('waiting_to_send')}</span
				>
			{/if}
			<AwaitingMark id={item.id} />
			{#if item.quantity}
				<span
					class="{done
						? 'bg-surface'
						: 'bg-idle'} text-ink-soft ms-auto shrink-0 rounded-full px-2.5 py-0.5 text-[13px] font-semibold tabular-nums"
					>{item.quantity}</span
				>
			{/if}
		</button>
		{#if !done}
			<span class="me-1 shrink-0">
				{#if wide.current}
					<Menu items={rowItems(item)} label={t('options_for', { title: item.title })}>
						{#snippet trigger({ attrs })}
							<IconButton label={t('options_for', { title: item.title })} {...attrs}>
								<MoreHorizontal class="size-5" />
							</IconButton>
						{/snippet}
					</Menu>
				{:else}
					<IconButton
						label={t('options_for', { title: item.title })}
						onclick={() => {
							sheetFor = item;
							sheetOpen = true;
						}}
					>
						<MoreHorizontal class="size-5" />
					</IconButton>
				{/if}
			</span>
		{/if}
	</div>
{/snippet}

{#snippet listMenuTrigger(attrs: Record<string, unknown>)}
	<IconButton label={t('list_options', { name: list ? listName(list) : '' })} {...attrs}>
		<MoreHorizontal class="size-5" />
	</IconButton>
{/snippet}

<Page template="list">
	<div class="@container" bind:clientWidth={width}>
		<ListsHeader page="shopping" count={toGet ? t('to_get', { count: toGet }) : ''} />

		<div class="grid gap-6">
			<!-- The lists, or a list's name being typed in their place. -->
			{#if listForm}
				{@const form = listForm}
				<form onsubmit={saveList} class="flex flex-wrap items-center gap-2">
					<Label for="list-name" class="sr-only">{t('list_name')}</Label>
					<Input
						id="list-name"
						bind:value={form.name}
						maxlength={LIST_NAME_MAX}
						required
						autocomplete="off"
						placeholder={t('list_name_placeholder')}
						class="bg-surface shadow-lit h-11 min-w-0 flex-1 basis-56 rounded-full border-0 px-4 text-base"
						onkeydown={(e) => {
							if (e.key === 'Escape') listForm = null;
						}}
						{@attach focusOnMount}
					/>
					<div class="flex items-center gap-1">
						<Button type="submit">{form.mode === 'new' ? t('create') : t('save')}</Button>
						<Button type="button" variant="ghost" onclick={() => (listForm = null)}
							>{t('cancel')}</Button
						>
					</div>
				</form>
			{:else}
				<div
					class="-mx-4 flex items-center gap-2 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:flex-wrap md:overflow-visible md:px-0"
					role="group"
					aria-label={t('lists_label')}
				>
					{#each lists as l (l.id)}
						<Chip
							on={l.id === list?.id}
							count={l.openCount || undefined}
							onclick={() => (selectedId = l.id)}
							title={listName(l)}
							class="max-w-56 shrink-0"
						>
							<span class="truncate">{listName(l)}</span>
						</Chip>
					{/each}
					<Chip
						variant="preset"
						aria-label={t('new_list')}
						title={t('new_list')}
						class="shrink-0"
						onclick={() => (listForm = { mode: 'new', name: '' })}
					>
						{#snippet lead()}<Plus />{/snippet}
						<span class="sr-only">{t('new_list')}</span>
					</Chip>
					{#if list}
						<span class="shrink-0">
							{#if wide.current}
								<Menu items={listItems} label={t('list_options', { name: listName(list) })}>
									{#snippet trigger({ attrs })}{@render listMenuTrigger(attrs)}{/snippet}
								</Menu>
							{:else}
								{@render listMenuTrigger({ onclick: () => (listSheetOpen = true) })}
							{/if}
						</span>
					{/if}
				</div>
			{/if}

			<!-- The add field: on a phone fixed above the tab bar, within the thumb's reach. -->
			<div
				class="from-wall via-wall pointer-events-none fixed inset-x-0 bottom-[calc(var(--fab-bottom,0px)+env(safe-area-inset-bottom)+var(--preview-bar-height,0px))] z-20 bg-gradient-to-t from-60% to-transparent px-4 pt-5 pb-3 md:pointer-events-auto md:static md:z-auto md:bg-none md:p-0"
				data-dock
			>
				<div class="pointer-events-auto">
					<Composer
						bind:value={quick}
						size="lg"
						label={t('add_item')}
						placeholder={t('add_item_placeholder')}
						disabled={!list}
						limit={SHOPPING_TITLE_MAX}
						tooLong={(counter) => t('too_long', { counter })}
						measure={(text) => longestTitle(text, t('quantity_units').split(','))}
						onsubmit={quickAdd}
					/>
				</div>
			</div>

			<div
				class="grid items-start gap-8 {twoColumns
					? 'grid-cols-[minmax(0,1fr)_minmax(15rem,20rem)]'
					: ''}"
			>
				<div class="grid min-w-0 gap-6">
					{#if loadError}
						<p class="text-attention font-semibold">{t('error')}</p>
					{:else if itemsLoaded && open.length === 0 && queuedAdds.length === 0}
						<div
							class="text-ink-soft flex flex-col items-center gap-2 py-6 text-center"
							data-testid="empty-state"
						>
							<EmptyArt name="shopping" />
							<p class="max-w-[34ch] text-[15px] leading-snug text-pretty">
								{#if bought.length}
									<span class="text-ink font-semibold">{t('all_in_cart')}</span>
								{:else}
									<span class="text-ink font-semibold">{t('list_empty')}</span>
									{t('list_empty_hint')}
								{/if}
							</p>
						</div>
					{/if}

					{#if queuedAdds.length || sections.length}
						<ul
							class="bg-surface divide-line grid divide-y rounded-[var(--r-card)] shadow-[inset_0_0_0_1px_var(--line)]"
							aria-label={t('to_get_label')}
						>
							{#if queuedAdds.length}
								<li>
									<ul class="divide-line grid divide-y" aria-label={t('waiting_to_send')}>
										{#each queuedAdds as item (item.id)}
											<li
												class="flex min-h-[52px] items-center gap-3 ps-4 pe-4"
												data-testid="queued-item"
											>
												<span class="min-w-0 truncate text-base font-semibold">{item.title}</span>
												<span class="text-ink-soft ms-auto shrink-0 text-xs font-semibold"
													>{t('waiting_to_send')}</span
												>
												{#if item.quantity}
													<span
														class="bg-idle text-ink-soft shrink-0 rounded-full px-2.5 py-0.5 text-[13px] font-semibold"
														>{item.quantity}</span
													>
												{/if}
											</li>
										{/each}
									</ul>
								</li>
							{/if}
							{#each sections as section (section.category)}
								<li>
									<section aria-label={catLabel(section.category)}>
										{#if sections.length > 1 || queuedAdds.length}
											<h2
												class="text-ink-soft px-4 pt-3.5 pb-1 text-xs font-bold tracking-[0.06em] uppercase"
											>
												{catLabel(section.category)}
											</h2>
										{/if}
										<ul class="divide-line grid divide-y">
											{#each section.items as item (item.id)}
												<li transition:move={{ id: item.id }}>{@render itemRow(item)}</li>
											{/each}
										</ul>
									</section>
								</li>
							{/each}
						</ul>
					{/if}
				</div>

				{#if bought.length}
					<section class="grid gap-2" aria-label={t('in_cart')}>
						<div class="flex min-h-11 items-center gap-2">
							{#if twoColumns}
								<h2 class="text-ink-soft flex items-baseline gap-2 ps-1 text-xs">
									<span class="font-bold tracking-[0.06em] uppercase">{t('in_cart')}</span>
									<span class="font-semibold">{bought.length}</span>
								</h2>
							{:else}
								<button
									type="button"
									class="text-ink-soft hover:text-ink flex min-h-11 items-center gap-1.5 text-start text-xs"
									aria-expanded={showBought}
									onclick={() => (showBought = !showBought)}
								>
									<ChevronRight
										class="size-4 transition-transform motion-reduce:transition-none {showBought
											? 'rotate-90'
											: ''}"
									/>
									<span class="font-bold tracking-[0.06em] uppercase">{t('in_cart')}</span>
									<span class="font-semibold">· {bought.length}</span>
								</button>
							{/if}
							{#if list}
								{@const listId = list.id}
								<span class="ms-auto text-[13px]"
									><ConfirmButton
										label={t('clear_cart')}
										confirmLabel={t('clear_bought_confirm')}
										onconfirm={() => clear(listId)}
									/></span
								>
							{/if}
						</div>
						{#if cartOpen}
							<ul class="bg-idle divide-line grid divide-y rounded-[var(--r-card)]">
								{#each bought as item (item.id)}
									<li transition:move={{ id: item.id }}>{@render itemRow(item)}</li>
								{/each}
							</ul>
						{/if}
					</section>
				{/if}
			</div>
			<!-- Room for the add field above the tab bar. -->
			<div class="h-8 md:hidden" aria-hidden="true"></div>
		</div>
	</div>
</Page>

<ActionSheet
	bind:open={sheetOpen}
	title={sheetFor?.title ?? ''}
	items={sheetFor ? rowItems(sheetFor) : []}
	cancelLabel={t('cancel')}
/>

<ActionSheet
	bind:open={listSheetOpen}
	title={list ? listName(list) : ''}
	items={listItems}
	cancelLabel={t('cancel')}
/>

<Dialog
	open={confirmRemove && list !== null}
	title={t('remove_list_title', { name: list ? listName(list) : '' })}
	description={t('remove_list_hint')}
	onclose={() => (confirmRemove = false)}
>
	{#snippet actions()}
		<Button variant="ghost" onclick={() => (confirmRemove = false)}>{t('cancel')}</Button>
		<Button variant="danger" data-armed="true" onclick={removeList}>{t('remove_list')}</Button>
	{/snippet}
</Dialog>

<SidePanel
	open={editing !== null}
	title={t('edit_item')}
	onclose={() => (editing = null)}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={t('save')}
	onsave={() => editForm?.requestSubmit()}
	danger={editing ? deleteItemButton : undefined}
	{dirty}
	discard={{
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	}}
>
	{#if editing}
		<form bind:this={editForm} onsubmit={saveEdit} class="grid gap-5" novalidate>
			<div class="grid gap-1.5">
				<Label for="item-title">{t('field_title')}</Label>
				<Input
					id="item-title"
					bind:value={editing.title}
					required
					aria-invalid={showEditErrors && lengthState(editing.title, SHOPPING_TITLE_MAX).over
						? 'true'
						: undefined}
					autocomplete="off"
				/>
				<LimitCounter
					text={editing.title}
					max={SHOPPING_TITLE_MAX}
					tooLong={(counter) => t('too_long', { counter })}
				/>
			</div>
			<div class="grid gap-1.5">
				<Label for="item-quantity"
					>{t('field_quantity')}
					<span class="text-ink-soft font-normal">{t('optional')}</span></Label
				>
				<Input
					id="item-quantity"
					bind:value={editing.quantity}
					aria-invalid={showEditErrors && lengthState(editing.quantity, SHOPPING_QUANTITY_MAX).over
						? 'true'
						: undefined}
					autocomplete="off"
				/>
				<LimitCounter
					text={editing.quantity}
					max={SHOPPING_QUANTITY_MAX}
					tooLong={(counter) => t('too_long', { counter })}
				/>
			</div>
			<div class="grid gap-1.5">
				<Label for="item-category">{t('field_category')}</Label>
				<select
					id="item-category"
					bind:value={editing.category}
					class="border-input h-9 rounded-md border bg-transparent px-2 text-base md:text-sm"
				>
					{#each CATEGORIES as category (category)}<option value={category}
							>{catLabel(category)}</option
						>{/each}
				</select>
			</div>
			<button type="submit" class="sr-only" tabindex="-1" aria-hidden="true">{t('save')}</button>
		</form>
	{/if}
</SidePanel>
