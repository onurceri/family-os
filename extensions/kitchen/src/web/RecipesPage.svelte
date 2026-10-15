<script lang="ts">
	import { Button } from '@famos/ui/button';
	import { Chip, EmptyState, Fab, IconButton, ListDetail, Row, SidePanel } from '@famos/ui/famos';
	import { CalendarPlus, CookingPot, Plus, Search } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import type { RecipeSummary } from '../contract/index.js';
	import { createRecipe, loadRecipes, recipePhotoUrl } from './data.js';
	import { emptyRecipe, type RecipeFormValue, toFields, validate } from './form.js';
	import { useKitchen } from './i18n.js';
	import KitchenFrame from './KitchenFrame.svelte';
	import { openPath } from './nav.js';
	import PlanPanel from './PlanPanel.svelte';
	import RecipeForm from './RecipeForm.svelte';

	/**
	 * The Recipes tab: search, labels as chips, the recipes as rows, typing one in. On wide windows
	 * the recipes sit in a column and the chosen one (`detail`, from the recipe page) opens on the
	 * right; with one recipe, that recipe is the page.
	 */
	let { selectedId = '', detail: selectedDetail }: { selectedId?: string; detail?: Snippet } =
		$props();
	const { app, t } = useKitchen();

	let all = $state<RecipeSummary[]>([]);
	let q = $state('');
	let tag = $state('');
	let loaded = $state(false);
	let loadError = $state(false);
	async function load() {
		try {
			all = await loadRecipes();
			loadError = false;
		} catch {
			loadError = true;
		} finally {
			loaded = true;
		}
	}
	$effect(() => {
		if (!app.can('kitchen.view')) return;
		void load();
		return app.onEvent('kitchen.', () => void load());
	});

	const canEdit = $derived(app.can('kitchen.edit'));
	// Without edit rights a change is proposed and waits for approval.
	const canChange = $derived(canEdit || app.can('core.drafts.propose'));
	const tags = $derived(
		[...new Set(all.flatMap((r) => r.tags))].toSorted((a, b) => a.localeCompare(b)),
	);
	const shown = $derived(
		all
			.filter(
				(r) => !q.trim() || r.title.toLocaleLowerCase().includes(q.trim().toLocaleLowerCase()),
			)
			.filter((r) => !tag || r.tags.some((x) => x.toLocaleLowerCase() === tag.toLocaleLowerCase())),
	);
	let mode = $state<'none' | 'add'>('none');
	let form = $state<RecipeFormValue>(emptyRecipe());
	let baseline = $state('');
	const dirty = $derived(mode === 'add' && JSON.stringify(form) !== baseline);
	let formEl = $state<HTMLFormElement>();
	let showErrors = $state(false);
	let busy = $state(false);
	const errors = $derived(showErrors ? validate(form) : {});
	const empty = $derived(loaded && !loadError && all.length === 0);

	function openAdd() {
		form = emptyRecipe();
		baseline = JSON.stringify(form);
		showErrors = false;
		mode = 'add';
	}
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		showErrors = true;
		if (Object.keys(validate(form)).length) return;
		busy = true;
		try {
			const { outcome, id } = await createRecipe(toFields(form));
			if (outcome === 'drafted') app.sentForApproval();
			else app.toast(t('saved'));
			mode = 'none';
			if (id) openPath(`/kitchen/recipes/${id}`);
			else await load();
		} catch {
			app.toast(t('error'));
		} finally {
			busy = false;
		}
	}

	// Planning a recipe straight from its row.
	let planning = $state<RecipeSummary | null>(null);

	const meta = (r: RecipeSummary) =>
		[
			r.servings ? t('servings_short', { servings: r.servings }) : '',
			r.totalMinutes ? t('minutes_short', { count: r.totalMinutes }) : '',
		]
			.filter(Boolean)
			.join(' · ');
</script>

<!-- Room at the row's end for the Plan button laid over it. -->
{#snippet planRoom()}<span class="block size-9" aria-hidden="true"></span>{/snippet}

{#snippet listBody()}
	{#if all.length > 1}
		<div class="mb-4 grid gap-3">
			<label class="bg-idle text-ink-soft flex h-[var(--ctl)] items-center gap-2 rounded-full px-4">
				<Search class="size-[18px] shrink-0" aria-hidden="true" />
				<span class="sr-only">{t('search')}</span>
				<input
					bind:value={q}
					type="search"
					placeholder={t('search')}
					autocomplete="off"
					class="text-ink min-w-0 flex-1 bg-transparent text-[15px] outline-none"
				/>
			</label>
			{#if tags.length}
				<div class="flex flex-wrap gap-1.5" role="group" aria-label={t('tag_filter')}>
					{#each tags as x (x)}
						<Chip on={tag === x} onclick={() => (tag = tag === x ? '' : x)}>{x}</Chip>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	{#if loadError}
		<p class="text-attention font-semibold" role="alert">{t('error')}</p>
	{:else if loaded && shown.length === 0 && all.length > 0}
		<p class="text-ink-soft">{t('no_match')}</p>
	{/if}

	<ul class="grid gap-1.5">
		{#each shown as r (r.id)}
			<!-- The Plan button sits on the row's end, beside the link (a button cannot be inside it). -->
			<li class="relative">
				<Row
					tile
					trail={canChange ? planRoom : undefined}
					href="/kitchen/recipes/{r.id}"
					title={r.title}
					meta={meta(r) || undefined}
					selected={r.id === selectedId}
				>
					{#snippet lead()}
						{#if r.hasPhoto}
							<img
								src={recipePhotoUrl(r.id, r.updatedAt)}
								alt=""
								loading="lazy"
								class="bg-idle size-9 rounded-full object-cover"
							/>
						{:else}
							<span class="bg-idle text-ink-soft grid size-9 place-items-center rounded-full"
								><CookingPot class="size-[18px]" aria-hidden="true" /></span
							>
						{/if}
					{/snippet}
				</Row>
				{#if canChange}
					<span class="absolute end-3 top-1/2 -translate-y-1/2">
						<IconButton
							size="sm"
							label={t('plan_recipe_named', { title: r.title })}
							onclick={() => (planning = r)}><CalendarPlus /></IconButton
						>
					</span>
				{/if}
			</li>
		{/each}
	</ul>
{/snippet}

{#snippet add()}
	{#if canChange}
		<Button onclick={openAdd} class="max-md:hidden"><Plus class="size-4" />{t('add_recipe')}</Button
		>
	{/if}
{/snippet}

<SidePanel
	open={mode === 'add'}
	title={t('form_title')}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={t('save')}
	saveDisabled={busy}
	onsave={() => formEl?.requestSubmit()}
	note={app.needsApproval('kitchen.edit') ? app.t('app:draft_approval_note') : undefined}
	onclose={() => (mode = 'none')}
	{dirty}
	discard={{
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	}}
>
	<form bind:this={formEl} onsubmit={submit} class="grid gap-4" aria-label={t('form_title')}>
		<RecipeForm bind:value={form} {errors} idPrefix="new-recipe" />
	</form>
</SidePanel>

<PlanPanel open={planning !== null} recipe={planning} onclose={() => (planning = null)} />

<KitchenFrame tab="recipes" headerActions={empty ? undefined : add}>
	<ListDetail
		selected={!!selectedDetail}
		count={all.length}
		first={all[0] ? `/kitchen/recipes/${all[0].id}` : undefined}
	>
		{#snippet list()}
			{#if empty}
				<EmptyState art="kitchen" title={t('empty_recipes')} hint={t('empty_recipes_hint')}>
					{#if canChange}
						<Button onclick={openAdd}><Plus class="size-4" />{t('add_recipe')}</Button>
					{/if}
				</EmptyState>
			{:else}
				{@render listBody()}
			{/if}
		{/snippet}
		{#snippet detail()}{#if selectedDetail}{@render selectedDetail()}{/if}{/snippet}
	</ListDetail>
</KitchenFrame>

{#if !empty && canChange && mode !== 'add' && !selectedDetail}
	<div class="md:hidden"><Fab label={t('add_recipe')} onclick={openAdd} /></div>
{/if}
