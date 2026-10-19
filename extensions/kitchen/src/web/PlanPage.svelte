<script lang="ts">
	import { addDays, formatDate, todayIn, weekOf } from '@famos/time';
	import { Card, IconButton, Pill, Section } from '@famos/ui/famos';
	import { Button } from '@famos/ui/button';
	import { ChevronLeft, ChevronRight, Plus, X } from '@lucide/svelte';
	import type { MealEntry, MealSlot, RecipeSummary } from '../contract/index.js';
	import { loadMeals, loadRecipes, type Outcome, removeMeal } from './data.js';
	import { useKitchen } from './i18n.js';
	import KitchenFrame from './KitchenFrame.svelte';
	import { slotLines, weekOffset } from './plan.js';
	import PlanPanel from './PlanPanel.svelte';

	/**
	 * The Meal plan tab: one week at a time. Seven columns from 1280 px, a day after the other
	 * below. Each day shows breakfast, lunch and dinner; tapping an empty one opens the panel (a sheet
	 * on a phone) for that day and meal with the recipes first. `?date=` opens the week of that day.
	 */
	const { app, t } = useKitchen();

	const today = $derived(todayIn(app.timeZone(), Date.now()));
	// Opened from a toast's "See the plan": the week of the day just planned.
	let offset = $state(
		weekOffset(
			todayIn(app.timeZone(), Date.now()),
			new URLSearchParams(location.search).get('date') ?? '',
			app.weekStart(),
		),
	);
	const days = $derived(weekOf(addDays(today, offset * 7), app.weekStart()));
	let meals = $state<MealEntry[]>([]);
	let recipes = $state<RecipeSummary[]>([]);
	let loadError = $state(false);
	async function load() {
		const [first, last] = [days[0], days[6]];
		if (!first || !last) return;
		try {
			meals = await loadMeals(first, last);
			loadError = false;
		} catch {
			loadError = true;
		}
	}
	$effect(() => {
		if (!app.can('kitchen.view')) return;
		void days;
		void load();
		return app.onEvent('kitchen.', () => void load());
	});
	$effect(() => {
		if (!app.can('kitchen.view')) return;
		void loadRecipes().then(
			(list) => (recipes = list),
			() => (recipes = []),
		);
	});

	// Without the right to plan, a change is proposed and waits for approval.
	const mayPlan = $derived(app.access('kitchen.addToMealPlan') !== 'no');
	const mayUnplan = $derived(app.access('kitchen.removeMealPlanEntry') !== 'no');
	const suggestsPlan = $derived(app.access('kitchen.addToMealPlan') === 'suggest');
	const label = (date: string) =>
		formatDate(date, app.dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' });
	/** A day's heading: the weekday and the day. */
	const columnLabel = (date: string) =>
		formatDate(date, app.dateLocale(), { weekday: 'short', day: 'numeric' });
	const rangeLabel = $derived(
		days[0] && days[6]
			? `${formatDate(days[0], app.dateLocale(), { day: 'numeric', month: 'short' })} – ${formatDate(days[6], app.dateLocale(), { day: 'numeric', month: 'short' })}`
			: '',
	);
	const report = (outcome: Outcome, message?: string) => {
		if (outcome === 'drafted') app.sentForApproval();
		else if (message) app.toast(message);
	};

	let addingFor = $state<string | null>(null);
	let addingSlot = $state<MealSlot>('dinner');
	function openAdd(date: string, slot: MealSlot = 'dinner') {
		addingFor = date;
		addingSlot = slot;
	}
	async function remove(entry: MealEntry) {
		try {
			report(await removeMeal(entry.id));
			await load();
		} catch {
			app.toast(t('error'));
		}
	}
</script>

<KitchenFrame tab="plan">
	<div class="mb-1 flex flex-wrap items-center gap-1" role="group" aria-label={t('week_nav')}>
		<IconButton label={t('prev_week')} variant="outline" onclick={() => (offset -= 1)}
			><ChevronLeft /></IconButton
		>
		<b class="min-w-40 text-center text-[15px]" aria-live="polite" data-testid="week-label"
			>{rangeLabel}</b
		>
		<IconButton label={t('next_week')} variant="outline" onclick={() => (offset += 1)}
			><ChevronRight /></IconButton
		>
		{#if offset !== 0}
			<Button variant="ghost" onclick={() => (offset = 0)}>{t('this_week')}</Button>
		{/if}
	</div>

	{#if loadError}<p class="text-attention font-semibold" role="alert">{t('error')}</p>{/if}

	<!-- Seven columns from 1280 px, a day after the other below. The panel covers the right side at 1024-1279. -->
	<ul class="grid gap-x-3 gap-y-6 xl:grid-cols-7 xl:items-start" data-testid="week-board">
		{#each days as date (date)}
			<li class="min-w-0" aria-label={label(date)}>
				<Section label={columnLabel(date)} level={2}>
					{#snippet actions()}
						{#if date === today}<Pill tone="info">{t('today')}</Pill>{/if}
						{#if mayPlan}
							<IconButton
								size="sm"
								label={t('plan_for', { date: label(date) })}
								onclick={() => openAdd(date)}><Plus /></IconButton
							>
						{/if}
					{/snippet}
					<Card variant={date === today ? 'lit' : 'plain'} rows>
						{#each slotLines(date, meals) as line (line.slot)}
							{#each line.meals as m (m.id)}
								<div class="flex min-h-12 items-center gap-2 px-3 py-1.5">
									<div class="grid min-w-0 flex-1 gap-px">
										<span class="text-ink-soft text-[12px] font-bold tracking-[0.04em] uppercase"
											>{t(`slot_${m.slot}`)}</span
										>
										{#if m.recipeId}
											<a
												href="/kitchen/recipes/{m.recipeId}"
												class="text-[15px] leading-snug font-semibold hover:underline">{m.title}</a
											>
										{:else}
											<span class="text-[15px] leading-snug font-semibold">{m.title}</span>
										{/if}
									</div>
									{#if mayUnplan}
										<IconButton
											size="sm"
											label={app.access('kitchen.removeMealPlanEntry') === 'suggest'
												? app.t('app:suggest_remove')
												: t('remove_meal', { title: m.title })}
											onclick={() => remove(m)}><X /></IconButton
										>
									{/if}
								</div>
							{:else}
								<!-- An empty meal: tap to fill it. -->
								{#if mayPlan}
									<button
										type="button"
										class="text-ink-soft hover:text-ink flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-start text-[14px] font-medium"
										aria-label={t('plan_slot_on', {
											slot: t(`slot_${line.slot}`),
											date: label(date),
										})}
										onclick={() => openAdd(date, line.slot)}
										><Plus class="size-3.5 shrink-0" aria-hidden="true" />{t(
											`slot_${line.slot}`,
										)}</button
									>
								{:else}
									<p class="text-ink-soft flex min-h-11 items-center px-3 py-1.5 text-[14px]">
										{t(`slot_${line.slot}`)} · {t('plan_nothing')}
									</p>
								{/if}
							{/each}
						{/each}
					</Card>
				</Section>
			</li>
		{/each}
	</ul>
	{#if suggestsPlan}<p class="text-ink-soft text-sm">{t('plan_proposal_hint')}</p>{/if}
	<PlanPanel
		open={addingFor !== null}
		date={addingFor}
		mealSlot={addingSlot}
		{recipes}
		onPlan
		onclose={() => (addingFor = null)}
		onadded={() => void load()}
	/>
</KitchenFrame>
