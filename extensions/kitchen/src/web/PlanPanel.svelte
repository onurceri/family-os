<script lang="ts">
	import { formatDate, todayIn } from '@famos/time';
	import { Card, Notice, SidePanel } from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { CalendarDays, CookingPot, PencilLine } from '@lucide/svelte';
	import {
		MEAL_SLOTS,
		type MealEntry,
		type MealSlot,
		type RecipeSummary,
	} from '../contract/index.js';
	import { addMeal, loadMeals } from './data.js';
	import { useKitchen } from './i18n.js';
	import { openPath } from './nav.js';
	import { planPath } from './plan.js';
	import { plannedAlready } from './plan-duplicate.js';

	/**
	 * Putting a meal on the plan, in a panel (a sheet on a phone). With a `recipe` (from a recipe or
	 * the recipe list) it asks for the day and the meal; with a `date` (an empty place on the plan)
	 * it lists the recipes first and lets a person write something else. After adding, the toast
	 * links to the plan; on the plan itself (`onPlan`) the new meal shows and no toast is needed.
	 */
	let {
		open,
		recipe = null,
		date = null,
		mealSlot = 'dinner',
		recipes = [],
		onPlan = false,
		onclose,
		onadded,
	}: {
		open: boolean;
		/** The recipe to plan; the day is asked for. */
		recipe?: { id: string; title: string } | null;
		/** The day to plan (from the plan); the recipe is asked for. */
		date?: string | null;
		mealSlot?: MealSlot;
		recipes?: RecipeSummary[];
		onPlan?: boolean;
		onclose: () => void;
		onadded?: () => void;
	} = $props();
	const { app, t } = useKitchen();

	let day = $state('');
	let meal = $state<MealSlot>('dinner');
	let chosen = $state('');
	let title = $state('');
	let busy = $state(false);
	let formEl = $state<HTMLFormElement>();
	// Every opening starts from what the opener chose.
	$effect(() => {
		if (!open) return;
		day = date ?? todayIn(app.timeZone(), Date.now());
		meal = mealSlot;
		chosen = '';
		title = '';
	});

	// The meals of the chosen day, to warn before the same dish lands in the same meal twice.
	let dayMeals = $state<MealEntry[]>([]);
	let addAnyway = $state(false);
	$effect(() => {
		const wanted = day;
		if (!open || !wanted) {
			dayMeals = [];
			return;
		}
		void loadMeals(wanted, wanted).then(
			(meals) => {
				if (wanted === day) dayMeals = meals;
			},
			() => (dayMeals = []),
		);
	});

	const free = $derived(chosen === 'free' || recipes.length === 0);
	const repeated = $derived.by(() => {
		const recipeId = recipe?.id ?? (free ? '' : chosen);
		if (!recipeId && !title.trim()) return undefined;
		return plannedAlready(
			dayMeals,
			{ date: day, slot: meal, ...(recipeId ? { recipeId } : { title }) },
			app.locale(),
		);
	});
	// The agreement belongs to one dish on one day and meal.
	$effect(() => {
		void [day, meal, chosen, title, recipe?.id];
		addAnyway = false;
	});
	const dirty = $derived(open && !recipe && (chosen !== '' || title.trim() !== ''));
	const longDay = (value: string) =>
		formatDate(value, app.dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' });
	// A short title (a sheet's bar is narrow); the day is the first line of the panel.
	const heading = $derived(recipe || !date ? t('plan_this') : t('plan_meal'));

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const recipeId = recipe?.id ?? (free ? '' : chosen);
		if (!day || (!recipeId && !title.trim())) return;
		if (repeated && !addAnyway) return;
		busy = true;
		try {
			const outcome = await addMeal({
				date: day,
				slot: meal,
				...(recipeId ? { recipeId } : { title: title.trim() }),
			});
			const planned = day;
			onclose();
			onadded?.();
			if (outcome === 'drafted') app.toast(t('sent_for_approval'));
			// On the plan the new meal shows; elsewhere the toast says so and links to it.
			else if (!onPlan)
				app.toast(t('planned'), { label: t('see_plan'), run: () => openPath(planPath(planned)) });
		} catch {
			app.toast(t('error'));
		} finally {
			busy = false;
		}
	}
</script>

<SidePanel
	{open}
	title={heading}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={t('plan_add')}
	saveDisabled={busy ||
		(!recipe && !free && chosen === '') ||
		(repeated !== undefined && !addAnyway)}
	onsave={() => formEl?.requestSubmit()}
	{onclose}
	{dirty}
	discard={{
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	}}
>
	{#if open}
		<form bind:this={formEl} onsubmit={submit} class="grid gap-4" aria-label={heading}>
			{#if recipe}
				<p class="flex items-center gap-2 text-[15px] font-semibold">
					<CookingPot class="text-ink-soft size-[18px] shrink-0" aria-hidden="true" />{recipe.title}
				</p>
				<div class="grid gap-1.5">
					<Label for="plan-date">{t('plan_date')}</Label>
					<Input id="plan-date" type="date" bind:value={day} required />
				</div>
			{:else if date}
				<p class="flex items-center gap-2 text-[15px] font-semibold">
					<CalendarDays class="text-ink-soft size-[18px] shrink-0" aria-hidden="true" />{longDay(
						date,
					)}
				</p>
			{/if}
			<div class="grid gap-1.5">
				<Label for="plan-slot">{t('plan_slot')}</Label>
				<select
					id="plan-slot"
					bind:value={meal}
					class="border-input bg-wall h-[var(--ctl)] rounded-[var(--r-ctl)] border px-2.5 text-base md:text-sm"
				>
					{#each MEAL_SLOTS as s (s)}<option value={s}>{t(`slot_${s}`)}</option>{/each}
				</select>
			</div>
			{#if !recipe}
				{#if recipes.length}
					<fieldset class="grid gap-1.5">
						<legend class="mb-1.5 text-sm font-semibold">{t('plan_recipe')}</legend>
						<Card rows>
							{#each recipes as r (r.id)}
								<label class="flex min-h-12 cursor-pointer items-center gap-3 px-3 py-1.5">
									<input
										type="radio"
										name="plan-recipe"
										value={r.id}
										bind:group={chosen}
										class="accent-ink size-5 shrink-0"
									/>
									<span class="min-w-0 flex-1 text-[15px] font-semibold">{r.title}</span>
								</label>
							{/each}
							<label class="flex min-h-12 cursor-pointer items-center gap-3 px-3 py-1.5">
								<input
									type="radio"
									name="plan-recipe"
									value="free"
									bind:group={chosen}
									class="accent-ink size-5 shrink-0"
								/>
								<span class="text-ink-soft flex min-w-0 flex-1 items-center gap-2 text-[15px]"
									><PencilLine class="size-4 shrink-0" aria-hidden="true" />{t(
										'plan_free_text',
									)}</span
								>
							</label>
						</Card>
					</fieldset>
				{/if}
				{#if free}
					<div class="grid gap-1.5">
						<Label for="plan-title">{t('plan_title')}</Label>
						<Input id="plan-title" bind:value={title} maxlength={160} autocomplete="off" required />
					</div>
				{/if}
			{/if}
			{#if repeated}
				<Notice tone="warn">
					{t('plan_repeated', {
						title: repeated.title,
						slot: t(`slot_${meal}`),
						date: longDay(day),
					})}
				</Notice>
				<label class="flex min-h-10 cursor-pointer items-center gap-3 text-[15px]">
					<input type="checkbox" bind:checked={addAnyway} class="accent-ink size-5 shrink-0" />
					{t('plan_repeated_anyway')}
				</label>
			{/if}
		</form>
	{/if}
</SidePanel>
