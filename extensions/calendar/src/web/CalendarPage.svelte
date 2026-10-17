<script lang="ts">
	import { addDays, formatDate, todayIn, weekOf, zoned } from '@famos/time';
	import { Button } from '@famos/ui/button';
	import {
		Avatar,
		ConfirmButton,
		EmptyState,
		focusFirstInvalid,
		Page,
		PageHeader,
		SidePanel,
		ViewOnly,
		Timeline,
	} from '@famos/ui/famos';
	import { ChevronLeft, ChevronRight, Plus, Settings2 } from '@lucide/svelte';
	import type { TimelineItem } from '@famos/ui/slots';
	import { onDestroy } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import type { EventDetail, Occurrence, Tag } from '../contract/index.js';
	import {
		filterBoard,
		monthGrid,
		monthLabel,
		rangeLabel,
		sameMonth,
		shiftMonth,
	} from './board.js';
	import EventDetailView from './EventDetailView.svelte';
	import MonthBoard from './MonthBoard.svelte';
	import WeekBoard from './WeekBoard.svelte';
	import {
		createEvent,
		deleteEvent,
		loadEvent,
		loadRange,
		loadTags,
		type Outcome,
		onDay,
		replaceEvent,
	} from './data.js';
	import EventForm from './EventForm.svelte';
	import ExternalDetail from './ExternalDetail.svelte';
	import {
		emptyForm,
		type EventFormValue,
		formFrom,
		inputFrom,
		replaceFrom,
		validate,
	} from './form.js';
	import { useCalendar } from './i18n.js';
	import TagChip from './TagChip.svelte';
	import { toTimelineItem } from './timeline.js';
	import { filterByTags, loadTagFilter, pruneSelection, saveTagFilter } from './tags.js';

	const { app, t } = useCalendar();
	const tz = $derived(app.timeZone());

	let now = $state(Date.now());
	const clock = setInterval(() => (now = Date.now()), 30_000);
	onDestroy(() => clearInterval(clock));

	const today = $derived(todayIn(tz, now));
	let selected = $state<string | null>(null);
	const day = $derived(selected ?? today);
	const week = $derived(weekOf(day, app.weekStart()));

	// Tablets and up (768 px): an hour grid for the day or the week (1024 px and up), a month grid,
	// details in the side panel. Below 768 px: the phone's week strip and agenda.
	const tablet = new MediaQuery('min-width: 768px');
	const desktop = new MediaQuery('min-width: 1024px');
	let view = $state<'day' | 'week' | 'month'>('week');
	// Seven columns need 1024 px; narrower windows get the day.
	const shown = $derived(view === 'week' && !desktop.current ? 'day' : view);
	const grid = $derived(monthGrid(day, app.weekStart()));
	const boardMonth = $derived(shown === 'month');
	const boardDays = $derived(shown === 'day' ? [day] : week);
	// The phone's month toggle: a month grid with dots; a tap picks the day, whose agenda follows.
	let phoneMonth = $state(false);
	let memberFilter = $state<string[]>([]);
	let hiddenSources = $state<string[]>([]);
	// A family event opened for reading in the panel (Edit turns it into the form).
	let detail = $state<{ occurrence: Occurrence; event: EventDetail } | null>(null);

	let occurrences = $state<Occurrence[]>([]);
	let loadError = $state(false);
	// The range the occurrences were loaded for, so the grid knows when they are its own.
	let loadedRange = $state('');

	// Tag filter: remembered on this device. No selection shows everything.
	let tags = $state<Tag[]>([]);
	let tagFilter = $state<string[]>(loadTagFilter());
	const visible = $derived(filterByTags(occurrences, tagFilter));

	function toggleTag(name: string) {
		tagFilter = tagFilter.includes(name)
			? tagFilter.filter((n) => n !== name)
			: [...tagFilter, name];
		saveTagFilter(tagFilter);
	}

	async function refreshTags() {
		try {
			tags = await loadTags();
			const kept = pruneSelection(tagFilter, tags);
			if (kept.length !== tagFilter.length) {
				tagFilter = kept;
				saveTagFilter(kept);
			}
		} catch {
			// The filter simply stays as it was.
		}
	}

	async function load(from: string, to: string) {
		try {
			const loaded = await loadRange(from, to);
			occurrences = loaded;
			loadedRange = `${from}:${to}`;
			loadError = false;
		} catch {
			loadError = true;
		}
	}

	$effect(() => {
		const [from, to] = (tablet.current ? boardMonth : phoneMonth)
			? [grid[0] as string, grid[41] as string]
			: tablet.current && shown === 'day'
				? [day, day]
				: [week[0] as string, week[6] as string];
		void load(from, to);
		void refreshTags();
		return app.onEvent('calendar.', () => {
			void load(from, to);
			void refreshTags();
		});
	});

	const ready = $derived(
		loadedRange ===
			(boardMonth
				? `${grid[0]}:${grid[41]}`
				: shown === 'day'
					? `${day}:${day}`
					: `${week[0]}:${week[6]}`),
	);
	const dayItems = $derived(visible.filter((o) => onDay(o, day, tz)));
	const dotsFor = (date: string) => {
		const colors = visible
			.filter((o) => onDay(o, date, tz))
			.flatMap((o) =>
				o.source
					? [o.source.color]
					: (o.memberIds.length ? o.memberIds : ['all']).map(
							(id) => app.members().find((m) => m.id === id)?.color ?? 'var(--ink-soft)',
						),
			);
		return [...new Set(colors)].slice(0, 4);
	};

	// What the viewer may do with events: a control they may not use is not drawn, and an event they
	// may not change opens as details only. Suggesting counts as being able to: it waits for approval.
	const mayAdd = $derived(app.access('calendar.createEvent') !== 'no');
	const mayEdit = $derived(app.access('calendar.updateEvent') !== 'no');
	const mayDelete = $derived(app.access('calendar.deleteEvent') !== 'no');

	// Editor: a new event, or an existing one opened from one of its occurrences.
	type Editing = { mode: 'new' } | { mode: 'edit'; occurrence: Occurrence };
	let editing = $state<Editing | null>(null);
	// A subscription's event: shown read-only, never in the form.
	let viewing = $state<Occurrence | null>(null);
	let formEl = $state<HTMLFormElement | null>(null);

	let form = $state<EventFormValue | null>(null);
	// What the form held when it opened, to tell whether closing it would lose something.
	let baseline = $state('');
	const dirty = $derived(Boolean(editing && form) && JSON.stringify(form) !== baseline);
	const arm = () => (baseline = JSON.stringify(form));
	let showErrors = $state(false);
	let busy = $state(false);
	let saveError = $state<string | null>(null);
	const errors = $derived(form && showErrors ? validate(form) : {});

	function openNew() {
		if (!mayAdd) return;
		viewing = null;
		detail = null;
		form = emptyForm(day, zoned(Date.now(), tz));
		arm();
		editing = { mode: 'new' };
		showErrors = false;
		saveError = null;
	}

	async function openEdit(occurrence: Occurrence) {
		if (!occurrence.editable) {
			close();
			viewing = occurrence;
			return;
		}
		if (!mayEdit) {
			await openOnBoard(occurrence);
			return;
		}
		viewing = null;
		try {
			const detail = await loadEvent(occurrence.eventId);
			form = formFrom(detail);
			arm();
			editing = { mode: 'edit', occurrence };
			showErrors = false;
			saveError = null;
		} catch {
			app.toast(t('error'));
		}
	}

	function close() {
		editing = null;
		form = null;
		viewing = null;
		detail = null;
	}

	/** Wide board: an event opens in the panel, as details first and the form on Edit. */
	async function openOnBoard(occurrence: Occurrence) {
		close();
		if (!occurrence.editable) {
			viewing = occurrence;
			return;
		}
		try {
			detail = { occurrence, event: await loadEvent(occurrence.eventId) };
		} catch {
			app.toast(t('error'));
		}
	}

	function editDetail() {
		if (!detail || !mayEdit) return;
		form = formFrom(detail.event);
		arm();
		editing = { mode: 'edit', occurrence: detail.occurrence };
		detail = null;
		showErrors = false;
		saveError = null;
	}

	/** Wide board: empty space (or "+") in a day adds an event on that day. */
	function addOn(date: string, time?: string) {
		if (!mayAdd) return;
		close();
		form = emptyForm(date, zoned(Date.now(), tz));
		if (time) {
			const hour = Number(time.slice(0, 2));
			form.startTime = time;
			form.endTime = hour < 23 ? `${String(hour + 1).padStart(2, '0')}${time.slice(2)}` : '';
		}
		arm();
		editing = { mode: 'new' };
		showErrors = false;
		saveError = null;
	}

	function shift(direction: -1 | 1) {
		selected = boardMonth
			? shiftMonth(day, direction)
			: addDays(day, (shown === 'day' ? 1 : 7) * direction);
	}

	const boardItems = $derived(filterBoard(visible, memberFilter, hiddenSources));
	/** The subscribed calendars that have events in view, for their (dashed) filter chips. */
	const sources = $derived([
		...new Map(
			occurrences.flatMap((o) => (o.source ? [[o.source.id, o.source] as const] : [])),
		).values(),
	]);
	const rangeTitle = $derived(
		boardMonth
			? monthLabel(day, app.dateLocale())
			: shown === 'day'
				? formatDate(day, app.dateLocale(), {
						weekday: 'long',
						day: 'numeric',
						month: 'long',
						year: 'numeric',
					})
				: rangeLabel(week[0] as string, week[6] as string, app.dateLocale()),
	);
	const panelTitle = $derived(
		viewing
			? viewing.title
			: detail
				? detail.occurrence.title
				: editing?.mode === 'new'
					? t('add')
					: ((form?.title || t('title')) as string),
	);

	function report(outcome: Outcome, done: 'saved' | 'deleted') {
		if (outcome === 'drafted') app.sentForApproval();
		else app.toast(t(done));
		close();
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!form || !editing) return;
		showErrors = true;
		if (Object.keys(validate(form)).length) {
			void focusFirstInvalid(event.currentTarget);
			return;
		}
		busy = true;
		saveError = null;
		try {
			const id = editing.mode === 'edit' ? editing.occurrence.eventId : undefined;
			const date = form.date;
			report(
				await (id ? replaceEvent(id, replaceFrom(form)) : createEvent(inputFrom(form))),
				'saved',
			);
			selected = date;
		} catch (error) {
			saveError = app.failureText(error, t('error'));
		} finally {
			busy = false;
		}
	}

	async function remove(onlyThis: boolean) {
		const target = editing?.mode === 'edit' ? editing.occurrence : detail?.occurrence;
		if (!target) return;
		const { eventId, key } = target;
		try {
			report(await deleteEvent(eventId, onlyThis ? key : undefined), 'deleted');
		} catch {
			app.toast(t('error'));
		}
	}

	/** ← → move by a week (a day in the day view, a month in the month view), `t` returns to today. */
	function keys(e: KeyboardEvent) {
		if (!tablet.current || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
		if (
			(e.target as HTMLElement | null)?.closest(
				'input, textarea, select, [contenteditable], [role=dialog]',
			)
		)
			return;
		if (document.querySelector('[role="dialog"], [role="menu"]')) return;
		if (e.key === 'ArrowLeft') shift(-1);
		else if (e.key === 'ArrowRight') shift(1);
		else if (e.key === 't') selected = null;
	}

	const agendaLabels = $derived({
		allDay: t('all_day'),
		anytime: t('agenda_anytime'),
		evening: t('agenda_evening'),
		first: t('agenda_first'),
		until: (minutes: number) =>
			minutes < 90
				? t('agenda_in_minutes', { count: minutes })
				: t('agenda_in_hours', { count: Math.round(minutes / 60) }),
	});
	const agenda = $derived(
		dayItems.map((o): TimelineItem => ({
			...toTimelineItem(o, day, app),
			onselect: () => void openEdit(o),
		})),
	);
	const phoneTitle = $derived(monthLabel(day, app.dateLocale()));

	const short = (date: string) => formatDate(date, app.dateLocale(), { weekday: 'short' });
	const weekTitle = $derived(
		`${formatDate(week[0] as string, app.dateLocale(), { day: 'numeric', month: 'short' })} – ${formatDate(week[6] as string, app.dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' })}`,
	);
</script>

{#snippet eventForm()}
	{#if form && editing}
		<form
			bind:this={formEl}
			id="event-form"
			onsubmit={submit}
			class="grid gap-5"
			aria-label={editing.mode === 'new' ? t('add') : form.title || t('title')}
			novalidate
		>
			<EventForm bind:value={form} {errors} />
			{#if editing.mode === 'edit' && editing.occurrence.recurring}
				<p class="text-ink-soft text-sm">{t('edit_series_hint')}</p>
			{/if}
			{#if saveError}<p class="text-attention text-sm font-semibold" role="alert">
					{saveError}
				</p>{/if}
		</form>
	{/if}
{/snippet}

{#snippet eventDanger()}
	{#if editing?.mode === 'edit' && mayDelete}
		{#if editing.occurrence.recurring}
			<ConfirmButton
				label={t('delete_one')}
				confirmLabel={t('delete_one_confirm')}
				onconfirm={() => remove(true)}
			/>
			<ConfirmButton
				label={t('delete_series')}
				confirmLabel={t('delete_series_confirm')}
				onconfirm={() => remove(false)}
			/>
		{:else}
			<ConfirmButton
				label={t('delete')}
				confirmLabel={t('delete_confirm')}
				onconfirm={() => remove(false)}
			/>
		{/if}
	{/if}
{/snippet}

{#snippet tagFilterRow()}
	{#if tags.length}
		<div class="flex flex-wrap items-center gap-2" role="group" aria-label={t('tag_filter')}>
			<button
				type="button"
				aria-pressed={tagFilter.length === 0}
				onclick={() => {
					tagFilter = [];
					saveTagFilter([]);
				}}
				class="min-h-9 rounded-full px-3 text-sm font-bold {tagFilter.length === 0
					? 'bg-surface text-ink shadow-lit'
					: 'bg-idle text-ink-soft'}">{t('tag_all')}</button
			>
			{#each tags as tag (tag.name)}
				{@const on = tagFilter.includes(tag.name)}
				<button
					type="button"
					aria-pressed={on}
					onclick={() => toggleTag(tag.name)}
					class="min-h-9 rounded-full px-3 {on ? 'bg-surface text-ink shadow-lit' : 'bg-idle'}"
				>
					<TagChip name={tag.name} color={tag.color} />
				</button>
			{/each}
		</div>
	{/if}
{/snippet}

<svelte:window onkeydown={keys} />

<Page template="calendar">
	{#if tablet.current}
		<!-- The side panel is fixed on the right (from 1024 px); the board keeps clear of it. The page is
	exactly as tall as the window, so the board fills it. -->
		<div
			class="flex h-[calc(100dvh-var(--shell-top)-var(--shell-bottom))] min-h-[34rem] flex-col {viewing ||
			detail ||
			(editing && form)
				? 'lg:pe-[23.5rem] xl:pe-[27rem]'
				: ''}"
		>
			<header class="mb-4 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
				<!-- The title shares its row with the controls: never above 28 px, so Wall's larger page
			size keeps the row whole at 1440 px. -->
				<h1 class="type-page me-1 text-[length:min(var(--ramp-page,1.5rem),1.75rem)] xl:me-2">
					{t('title')}
				</h1>
				<div class="flex items-center">
					<Button
						variant="ghost"
						size="icon-lg"
						aria-label={boardMonth
							? t('previous_month')
							: shown === 'day'
								? t('previous_day')
								: t('previous_week')}
						onclick={() => shift(-1)}><ChevronLeft /></Button
					>
					<Button
						variant="ghost"
						size="icon-lg"
						aria-label={boardMonth
							? t('next_month')
							: shown === 'day'
								? t('next_day')
								: t('next_week')}
						onclick={() => shift(1)}><ChevronRight /></Button
					>
				</div>
				<p class="type-dateline whitespace-nowrap tabular-nums" data-testid="board-range">
					{rangeTitle}
				</p>
				<Button variant="secondary" size="lg" onclick={() => (selected = null)}>{t('today')}</Button
				>
				<div class="ms-auto flex flex-wrap items-center gap-x-3 gap-y-2">
					{#if app.members().length > 1}
						<div class="flex items-center gap-1.5" role="group" aria-label={t('member_filter')}>
							{#each app.members() as member (member.id)}
								{@const on = memberFilter.includes(member.id)}
								<button
									type="button"
									aria-pressed={on}
									aria-label={member.displayName}
									title={member.displayName}
									onclick={() =>
										(memberFilter = on
											? memberFilter.filter((id) => id !== member.id)
											: [...memberFilter, member.id])}
									class="focus-visible:ring-ring grid size-9 place-items-center rounded-full outline-none focus-visible:ring-2 {on
										? 'ring-ink ring-offset-wall ring-2 ring-offset-2'
										: memberFilter.length
											? 'opacity-55'
											: ''}"
								>
									<Avatar name={member.displayName} color={member.color} size={36} />
								</button>
							{/each}
						</div>
					{/if}
					<div class="bg-idle flex rounded-xl p-1" role="group" aria-label={t('view')}>
						{#each ['day', 'week', 'month'] as const as mode (mode)}
							{#if mode !== 'week' || desktop.current}
								<button
									type="button"
									aria-pressed={shown === mode}
									onclick={() => (view = mode)}
									class="min-h-9 rounded-lg px-3.5 text-sm font-bold {shown === mode
										? 'bg-surface text-ink shadow-lit'
										: 'text-ink-soft'}">{t(`view_${mode}`)}</button
								>
							{/if}
						{/each}
					</div>
					<Button
						size="icon-lg"
						variant="ghost"
						href={app.can('calendar.edit') ? '/settings/calendars' : '/settings/calendar-feed'}
						aria-label={t('connections_link')}
						title={t('connections_link')}
					>
						<Settings2 />
					</Button>
					{#if mayAdd}
						<Button size="lg" onclick={() => addOn(day)}><Plus class="size-4" />{t('add')}</Button>
					{:else}
						<ViewOnly label={app.t('app:view_only')} hint={app.t('app:view_only_hint')} />
					{/if}
				</div>
			</header>

			{#if sources.length || tags.length}
				<div class="mb-3 flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2">
					{#if sources.length}
						<div
							class="flex flex-wrap items-center gap-2"
							role="group"
							aria-label={t('member_filter')}
						>
							{#each sources as source (source.id)}
								{@const on = !hiddenSources.includes(source.id)}
								<button
									type="button"
									aria-pressed={on}
									onclick={() =>
										(hiddenSources = on
											? [...hiddenSources, source.id]
											: hiddenSources.filter((id) => id !== source.id))}
									class="flex min-h-9 items-center gap-2 rounded-full border-2 border-dashed px-3 text-sm font-bold {on
										? 'text-ink'
										: 'text-ink-soft opacity-60'}"
									style:border-color={source.color}
								>
									<span
										class="size-2.5 rounded-full"
										style:background-color={source.color}
										aria-hidden="true"
									></span>{source.name}
								</button>
							{/each}
						</div>
					{/if}
					{@render tagFilterRow()}
				</div>
			{/if}

			{#if loadError}
				<p class="text-attention shrink-0 font-semibold">{t('error')}</p>
			{/if}
			<div class="min-h-0 flex-1">
				{#if boardMonth}
					<MonthBoard
						{grid}
						focus={day}
						items={boardItems}
						{now}
						{today}
						onopen={openOnBoard}
						onday={(date) => {
							selected = date;
							view = 'day';
						}}
					/>
				{:else}
					<WeekBoard
						days={boardDays}
						items={boardItems}
						{now}
						{today}
						{ready}
						onopen={openOnBoard}
						onadd={mayAdd ? addOn : undefined}
						onday={(date) => {
							selected = date;
							view = 'day';
						}}
					/>
				{/if}
			</div>
		</div>
	{:else}
		<PageHeader title={t('title')} subtitle={phoneTitle}>
			{#snippet actions()}
				{#if !mayAdd}
					<ViewOnly label={app.t('app:view_only')} hint={app.t('app:view_only_hint')} />
				{/if}
				<Button
					size="icon-lg"
					variant="ghost"
					href={app.can('calendar.edit') ? '/settings/calendars' : '/settings/calendar-feed'}
					aria-label={t('connections_link')}
				>
					<Settings2 />
				</Button>
				<div class="bg-idle flex rounded-xl p-1" role="group" aria-label={t('view')}>
					{#each [false, true] as month (month)}
						<button
							type="button"
							aria-pressed={phoneMonth === month}
							onclick={() => (phoneMonth = month)}
							class="min-h-9 rounded-lg px-3.5 text-sm font-bold {phoneMonth === month
								? 'bg-surface text-ink shadow-lit'
								: 'text-ink-soft'}">{month ? t('view_month') : t('view_week')}</button
						>
					{/each}
				</div>
			{/snippet}
		</PageHeader>

		<div class="grid gap-6">
			<section class="grid gap-4" aria-label={formatDate(day, app.dateLocale())}>
				<div class="flex items-center gap-1">
					<Button
						variant="ghost"
						size="icon-lg"
						aria-label={phoneMonth ? t('previous_month') : t('previous_week')}
						onclick={() => (selected = phoneMonth ? shiftMonth(day, -1) : addDays(day, -7))}
						><ChevronLeft /></Button
					>
					{#if phoneMonth}
						<p class="flex-1 text-center font-bold">{monthLabel(day, app.dateLocale())}</p>
					{:else}
						<ol class="grid flex-1 grid-cols-7 gap-1">
							{#each week as date (date)}
								{@const isSelected = date === day}
								{@const isToday = date === today}
								<li>
									<button
										type="button"
										onclick={() => (selected = date)}
										aria-current={isToday ? 'date' : undefined}
										aria-pressed={isSelected}
										class="grid min-h-16 w-full justify-items-center gap-0.5 rounded-lg py-2 transition-colors {isSelected
											? 'bg-surface text-ink shadow-lit'
											: 'text-ink-soft hover:bg-idle'}"
									>
										<small class="text-[0.7rem] font-semibold uppercase">{short(date)}</small>
										<b
											class="type-day grid size-8 place-items-center rounded-full {isToday
												? 'bg-now text-on-color'
												: ''}">{Number(date.slice(8))}</b
										>
										<span class="flex h-1.5 gap-0.5" aria-hidden="true">
											{#each dotsFor(date) as color (color)}<span
													class="size-1.5 rounded-full"
													style:background-color={color}
												></span>{/each}
										</span>
									</button>
								</li>
							{/each}
						</ol>
					{/if}
					<Button
						variant="ghost"
						size="icon-lg"
						aria-label={phoneMonth ? t('next_month') : t('next_week')}
						onclick={() => (selected = phoneMonth ? shiftMonth(day, 1) : addDays(day, 7))}
						><ChevronRight /></Button
					>
				</div>

				{#if phoneMonth}
					<div class="grid gap-1" data-testid="phone-month">
						<div class="text-ink-soft grid grid-cols-7 text-center text-[11px] font-bold uppercase">
							{#each grid.slice(0, 7) as date (date)}<span>{short(date)}</span>{/each}
						</div>
						<ol class="grid grid-cols-7 gap-1">
							{#each grid as date (date)}
								{@const isToday = date === today}
								<li>
									<button
										type="button"
										onclick={() => (selected = date)}
										aria-label={formatDate(date, app.dateLocale())}
										aria-pressed={date === day}
										class="grid min-h-14 w-full content-start justify-items-center gap-1 rounded-lg py-1.5 {sameMonth(
											date,
											day,
										)
											? ''
											: 'opacity-45'} {date === day ? 'bg-surface shadow-lit' : ''}"
									>
										<b
											class="grid size-7 place-items-center rounded-full text-sm tabular-nums {isToday
												? 'bg-now text-on-color'
												: ''}">{Number(date.slice(8))}</b
										>
										<span class="flex h-1.5 gap-0.5" aria-hidden="true">
											{#each dotsFor(date) as color (color)}<span
													class="size-1.5 rounded-full"
													style:background-color={color}
												></span>{/each}
										</span>
									</button>
								</li>
							{/each}
						</ol>
					</div>
				{/if}

				<!-- The picked day's agenda: below the week strip, and below the month grid. -->
				{@render tagFilterRow()}

				<div class="flex items-center gap-3">
					<h2 class="type-dateline">{formatDate(day, app.dateLocale())}</h2>
					{#if day !== today}
						<Button variant="secondary" size="sm" onclick={() => (selected = null)}
							>{t('back_to_today')}</Button
						>
					{/if}
				</div>

				{#if loadError}
					<p class="text-attention font-semibold">{t('error')}</p>
				{:else if agenda.length === 0}
					<EmptyState
						art="calendar"
						title={tagFilter.length ? t('nothing_filtered') : t('nothing')}
						hint={tagFilter.length ? undefined : t('nothing_hint')}
					/>
				{:else}
					<Timeline items={agenda} {now} showNow={day === today} labels={agendaLabels} />
				{/if}
			</section>

			{#if viewing}
				<ExternalDetail occurrence={viewing} onclose={close} />
			{/if}
		</div>

		{#if !editing && !viewing && mayAdd}
			<button
				type="button"
				aria-label={t('add')}
				onclick={openNew}
				class="bg-primary text-primary-foreground focus-visible:ring-ring fixed end-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 grid size-14 place-items-center rounded-2xl shadow-lg outline-none focus-visible:ring-2"
			>
				<Plus class="size-6" aria-hidden="true" />
			</button>
		{/if}
	{/if}

	<!-- The event panel: beside the board from 1024 px, a sheet (Cancel, title, Save) below. -->
	<SidePanel
		open={tablet.current
			? Boolean(viewing || detail || (editing && form))
			: Boolean(detail || (editing && form))}
		title={panelTitle}
		onclose={close}
		closeLabel={t('close')}
		cancelLabel={t('cancel')}
		saveLabel={editing && form ? t('save') : undefined}
		saveDisabled={busy}
		onsave={editing && form ? () => formEl?.requestSubmit() : undefined}
		approval={editing && form
			? app.approval(editing.mode === 'new' ? 'calendar.createEvent' : 'calendar.updateEvent')
			: undefined}
		danger={editing?.mode === 'edit' && form && mayDelete ? eventDanger : undefined}
		{dirty}
		discard={{
			title: t('discard_title'),
			description: t('discard_hint'),
			keep: t('discard_keep'),
			discard: t('discard_confirm'),
		}}
	>
		{#if viewing}
			<ExternalDetail occurrence={viewing} onclose={close} bare />
		{:else if detail}
			<EventDetailView
				occurrence={detail.occurrence}
				event={detail.event}
				{tags}
				onedit={editDetail}
				ondelete={remove}
				{mayEdit}
				{mayDelete}
			/>
		{:else}
			{@render eventForm()}
		{/if}
	</SidePanel>
</Page>
