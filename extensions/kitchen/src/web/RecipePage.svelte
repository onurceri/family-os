<script lang="ts">
	import { Button } from '@famos/ui/button';
	import {
		ActionSheet,
		Card,
		ConfirmButton,
		focusFirstInvalid,
		IconButton,
		Menu,
		type MenuItem,
		Notice,
		Pill,
		RecordHeader,
		Section,
		SidePanel,
		wide,
	} from '@famos/ui/famos';
	import {
		ArrowLeft,
		Camera,
		CalendarPlus,
		CookingPot,
		Ellipsis,
		ExternalLink,
		ShoppingBasket,
	} from '@lucide/svelte';
	import type { Recipe } from '../contract/index.js';
	import {
		addToShopping,
		archiveRecipe,
		loadRecipe,
		loadShoppingLists,
		type Outcome,
		recipePhotoUrl,
		updateRecipe,
		uploadPhoto,
	} from './data.js';
	import {
		emptyRecipe,
		fromRecipe,
		isWebAddress,
		type RecipeFormValue,
		toFields,
		validate,
	} from './form.js';
	import { useKitchen } from './i18n.js';
	import { openPath } from './nav.js';
	import PlanPanel from './PlanPanel.svelte';
	import RecipeForm from './RecipeForm.svelte';
	import RecipesPage from './RecipesPage.svelte';
	import { shoppingSummary } from './shopping-summary.js';

	/**
	 * The recipes (`/kitchen`) and one recipe (`/kitchen/recipes/:id`): ingredients to tick, steps,
	 * planning and editing.
	 */
	let { params }: { params: Record<string, string> } = $props();
	const { app, t } = useKitchen();

	const recipeId = $derived(params.id ?? '');
	let recipe = $state<Recipe | null>(null);
	let missing = $state(false);
	let loadError = $state(false);
	async function load() {
		// A slower answer for the record chosen before must not replace this one.
		const id = recipeId;
		// The recipes alone (`/kitchen`): nothing chosen yet.
		if (!id) {
			recipe = null;
			missing = false;
			loadError = false;
			return;
		}
		try {
			const loaded = await loadRecipe(id);
			if (id !== recipeId) return;
			recipe = loaded;
			missing = false;
			loadError = false;
		} catch (error) {
			if (id !== recipeId) return;
			recipe = null;
			const status = (error as { status?: number }).status;
			missing = status === 404 || status === 400;
			loadError = !missing;
		}
	}
	$effect(() => {
		void recipeId;
		// Another record opened in the same mounted page: leave the editor and the planning panel.
		editing = false;
		planning = false;
		void load();
		return app.onEvent('kitchen.', () => void load());
	});

	const canEdit = $derived(app.can('kitchen.edit'));
	// Without edit rights a change is proposed and waits for approval.
	const canChange = $derived(canEdit || app.can('core.drafts.propose'));
	const report = (outcome: Outcome, message: string) => {
		if (outcome === 'drafted') app.sentForApproval();
		else app.toast(message);
	};

	// Ingredients to the shopping list.
	let picked = $state<Record<string, boolean>>({});
	const chosen = $derived((recipe?.ingredients ?? []).filter((line) => picked[line]));
	let shoppingLists = $state<{ id: string; name: string }[]>([]);
	let listId = $state('');
	// Read when the first recipe opens, and again whenever an extension is switched on or off:
	// Lists may be off or hidden from this person, and then the button is simply absent until
	// Lists is back.
	const recipeOpen = $derived(Boolean(recipeId));
	function readShoppingLists() {
		void loadShoppingLists().then(
			(lists) => {
				shoppingLists = lists;
				// The picker names every list, the first (the default) included.
				if (!lists.some((l) => l.id === listId)) listId = lists[0]?.id ?? '';
			},
			() => (shoppingLists = []),
		);
	}
	$effect(() => {
		if (!recipeOpen) return;
		readShoppingLists();
		return app.onEvent('core.features.', () => readShoppingLists());
	});
	let shopping = $state(false);
	// What the last add left out or found already there, shown under the ingredients.
	let shoppingDetails = $state<string[]>([]);
	$effect(() => {
		void recipeId;
		shoppingDetails = [];
	});
	async function toShopping() {
		if (!recipe || chosen.length === 0) return;
		shopping = true;
		try {
			const result = await addToShopping(recipe.id, chosen, listId || undefined);
			const summary = shoppingSummary(result, t);
			app.toast(summary.headline);
			shoppingDetails = summary.details;
			picked = {};
		} catch {
			app.toast(t('shopping_error'));
		} finally {
			shopping = false;
		}
	}
	const allPicked = $derived(
		(recipe?.ingredients.length ?? 0) > 0 &&
			(recipe?.ingredients ?? []).every((line) => picked[line]),
	);
	const toggleAll = () => {
		const all = recipe?.ingredients ?? [];
		const next = !all.every((line) => picked[line]);
		picked = Object.fromEntries(all.map((line) => [line, next]));
	};

	// Planning, in a panel (a sheet on a phone).
	let planning = $state(false);

	// Photo.
	let photoInput = $state<HTMLInputElement>();
	let uploading = $state(false);
	async function onPhoto(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file || !recipe) return;
		uploading = true;
		try {
			await uploadPhoto(recipe.id, file);
			app.toast(t('saved'));
			await load();
		} catch {
			app.toast(t('photo_error'));
		} finally {
			uploading = false;
		}
	}

	// Editing.
	let editing = $state(false);
	let form = $state<RecipeFormValue>(emptyRecipe());
	let baseline = $state('');
	const dirty = $derived(editing && JSON.stringify(form) !== baseline);
	let formEl = $state<HTMLFormElement>();
	let showErrors = $state(false);
	let busy = $state(false);
	const errors = $derived(showErrors ? validate(form) : {});
	function edit() {
		if (!recipe) return;
		form = fromRecipe(recipe);
		baseline = JSON.stringify(form);
		showErrors = false;
		editing = true;
	}
	async function save(event: SubmitEvent) {
		event.preventDefault();
		showErrors = true;
		if (!recipe || Object.keys(validate(form)).length) {
			void focusFirstInvalid(event.currentTarget);
			return;
		}
		busy = true;
		try {
			report(await updateRecipe(recipe.id, toFields(form)), t('saved'));
			editing = false;
			await load();
		} catch {
			app.toast(t('error'));
		} finally {
			busy = false;
		}
	}
	async function archive() {
		if (!recipe) return;
		try {
			const outcome = await archiveRecipe(recipe.id);
			report(outcome, t('archived'));
			editing = false;
			if (outcome === 'applied') openPath('/kitchen');
		} catch {
			app.toast(t('error'));
		}
	}

	// The menu of the recipe: a popover on a wide window, an action sheet on a phone.
	let menuOpen = $state(false);
	const menuItems = $derived<MenuItem[]>([
		...(canEdit
			? [
					{
						id: 'photo',
						label: recipe?.hasPhoto ? t('photo_change') : t('photo_add'),
						icon: photoIcon,
						onselect: () => photoInput?.click(),
					},
				]
			: []),
	]);

	const host = (url: string) => {
		try {
			return new URL(url).hostname;
		} catch {
			return url;
		}
	};
</script>

{#snippet photoIcon()}<Camera />{/snippet}

{#snippet page()}
	<a
		href="/kitchen"
		class="text-ink-soft mb-3 inline-flex min-h-11 items-center gap-1 text-sm font-bold lg:hidden"
		><ArrowLeft class="size-4" aria-hidden="true" />{t('back')}</a
	>

	{#if missing}
		<Notice>{t('not_found')}</Notice>
	{:else if loadError}
		<p class="text-attention font-semibold" role="alert">{t('error')}</p>
	{:else if recipe}
		{@const r = recipe}
		<RecordHeader
			name={recipe.title}
			recordId={recipe.id}
			facts={[
				recipe.servings ? t('servings_long', { servings: recipe.servings }) : null,
				recipe.totalMinutes ? t('minutes_long', { count: recipe.totalMinutes }) : null,
			]}
		>
			{#snippet icon()}
				{#if r.hasPhoto}
					<img src={recipePhotoUrl(r.id, r.updatedAt)} alt={r.title} />
				{:else}
					<CookingPot />
				{/if}
			{/snippet}
			{#snippet actions()}
				{#if canChange}
					<!-- Outline like Edit: the one filled button of the view is Add recipe in the header. -->
					<Button variant="outline" onclick={() => (planning = true)}
						><CalendarPlus class="size-4" />{t('plan_this')}</Button
					>
					<Button variant="outline" onclick={edit}>{t('edit')}</Button>
				{/if}
				{#if menuItems.length}
					{#if wide.current}
						<Menu
							items={menuItems}
							label={t('options_for', { title: r.title })}
							bind:open={menuOpen}
						>
							{#snippet trigger({ attrs })}
								<IconButton
									variant="outline"
									label={t('options_for', { title: r.title })}
									{...attrs}><Ellipsis /></IconButton
								>
							{/snippet}
						</Menu>
					{:else}
						<IconButton
							variant="outline"
							label={t('options_for', { title: r.title })}
							aria-haspopup="dialog"
							onclick={() => (menuOpen = true)}><Ellipsis /></IconButton
						>
						<ActionSheet
							bind:open={menuOpen}
							title={r.title}
							items={menuItems}
							cancelLabel={t('cancel')}
						/>
					{/if}
				{/if}
			{/snippet}
		</RecordHeader>

		{#if canEdit}
			<input
				bind:this={photoInput}
				type="file"
				accept="image/jpeg,image/png,image/webp"
				class="sr-only"
				tabindex="-1"
				aria-hidden="true"
				disabled={uploading}
				onchange={onPhoto}
			/>
		{/if}

		<div class="grid max-w-3xl gap-7">
			{#if recipe.tags.length || isWebAddress(recipe.sourceUrl)}
				<div class="flex flex-wrap items-center gap-2">
					<ul class="contents" aria-label={t('field_tags')}>
						{#each recipe.tags as tag (tag)}<li><Pill>{tag}</Pill></li>{/each}
					</ul>
					{#if isWebAddress(recipe.sourceUrl)}
						<a
							href={recipe.sourceUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="text-info inline-flex min-h-9 items-center gap-1 text-sm font-semibold underline"
							><ExternalLink class="size-4" aria-hidden="true" />{t('source_link', {
								host: host(recipe.sourceUrl),
							})}</a
						>
					{/if}
				</div>
			{/if}

			{#if recipe.ingredients.length}
				<Section label={t('ingredients')} count={recipe.ingredients.length}>
					{#snippet actions()}
						<Button variant="ghost" size="sm" onclick={toggleAll}
							>{allPicked ? t('clear_all') : t('select_all')}</Button
						>
						{#if shoppingLists.length}
							<Button
								variant="ghost"
								size="sm"
								disabled={chosen.length === 0 || shopping}
								onclick={toShopping}
								><ShoppingBasket class="size-4" />{t('shopping_add_selected')}</Button
							>
						{/if}
					{/snippet}
					<Card rows>
						{#each recipe.ingredients as line, i (i)}
							<label class="flex min-h-12 cursor-pointer items-center gap-3 px-3 py-1.5">
								<input
									type="checkbox"
									bind:checked={picked[line]}
									class="accent-ink size-5 shrink-0"
								/>
								<span class="text-[15px]">{line}</span>
							</label>
						{/each}
						{#if shoppingLists.length > 1}
							<div class="flex min-h-12 items-center gap-3 px-3 py-1.5">
								<span class="text-ink-soft text-[13px]">{t('shopping_list_choice')}</span>
								<select
									bind:value={listId}
									aria-label={t('shopping_list_choice')}
									class="border-input bg-wall h-9 rounded-[var(--r-ctl)] border px-2.5 text-sm"
								>
									{#each shoppingLists as l (l.id)}<option value={l.id}>{l.name}</option>{/each}
								</select>
							</div>
						{/if}
					</Card>
					{#if shoppingDetails.length}
						<ul class="mt-2 grid gap-1" aria-label={t('shopping_details')}>
							{#each shoppingDetails as detail, i (i)}
								<li class="text-ink-soft text-[13px]">{detail}</li>
							{/each}
						</ul>
					{/if}
				</Section>
			{/if}

			{#if recipe.steps.length}
				<Section label={t('steps')} count={recipe.steps.length}>
					<ol class="grid max-w-[62ch] gap-3">
						{#each recipe.steps as step, i (i)}
							<li class="flex gap-3">
								<span
									class="bg-idle grid size-7 shrink-0 place-items-center rounded-full text-[13px] font-bold"
									>{i + 1}</span
								>
								<span class="pt-0.5 text-[15px] leading-[1.45]">{step}</span>
							</li>
						{/each}
					</ol>
				</Section>
			{/if}

			{#if recipe.notes}
				<Section label={t('field_notes')}>
					<p class="max-w-[62ch] text-[15px] leading-[1.45] whitespace-pre-line">{recipe.notes}</p>
				</Section>
			{/if}
		</div>
	{/if}
{/snippet}

<!-- The recipes, with the chosen one beside them on wide windows; on a phone one or the other. -->
{#if wide.current || !recipeId}
	<RecipesPage selectedId={recipeId} detail={recipeId ? page : undefined} />
{:else}
	{@render page()}
{/if}

<!-- Changing the recipe, and putting it on the plan, open beside the page (a sheet on a phone). -->
<SidePanel
	open={editing}
	title={t('form_title')}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={t('save')}
	saveDisabled={busy}
	onsave={() => formEl?.requestSubmit()}
	note={app.needsApproval('kitchen.edit') ? app.t('app:draft_approval_note') : undefined}
	onclose={() => (editing = false)}
	{dirty}
	discard={{
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	}}
>
	{#snippet danger()}
		<ConfirmButton label={t('archive')} confirmLabel={t('archive_confirm')} onconfirm={archive} />
	{/snippet}
	<form bind:this={formEl} onsubmit={save} class="grid gap-4" aria-label={t('form_title')}>
		<RecipeForm bind:value={form} {errors} idPrefix="edit-recipe" />
		<small class="text-ink-soft text-[13px]">{t('archive_hint')}</small>
	</form>
</SidePanel>

<PlanPanel
	open={planning}
	recipe={recipe ? { id: recipe.id, title: recipe.title } : null}
	onclose={() => (planning = false)}
/>
