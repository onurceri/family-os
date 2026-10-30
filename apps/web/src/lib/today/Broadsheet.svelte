<script lang="ts">
	import {
		ChoreRings,
		Clock,
		DateLine,
		FamilyList,
		formatClock,
		MemberDay,
		NextUpHero,
		type NextUpMode,
		PhotoTile,
		QuietLine,
		Segmented,
		TodayBlock,
		TodayBlockMenu,
		TodayRow,
		TodaySection,
	} from '@famos/ui/famos';
	import Slot from '@famos/ui/slot';
	import { groupOf } from '@famos/ui/timeline';
	import type { TimelineItem } from '@famos/ui/slots';
	import type { Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import FirstSteps from '#lib/FirstSteps.svelte';
	import { t } from '#lib/i18n.svelte.js';
	import SearchBox from '#lib/SearchBox.svelte';
	import { byTightness, type CompositionProps, type FitDrop, endedFirst } from './display-fit.js';

	/**
	 * Broadsheet: Today in three voices on three
	 * columns. From 1280 px `280px 1fr 300px`: the atmosphere (the clock, the date, the weather,
	 * the photo, then everyone's status and the chores as rings: how is everyone, at a glance),
	 * the day (the next thing on the accent, the rest of the day as a column per person, the
	 * board, what is ahead) and what needs doing (Needs you, shopping as a number, the tasks, the
	 * kitchen). From 1024 px the atmosphere is a band on top, everyone's status and the chores
	 * join the right column and the tasks the day; below 1024 px one column, in the order of `--o`, with the day by person
	 * stacked.
	 *
	 * Purely presentational: everything comes from `TodayData`, which also says when the page has
	 * settled. Until then only the head (clock, date, sentence) shows; the rest is mounted but
	 * hidden so the cards can load and report, and the page composes once. The columns are
	 * CSS, so a card is mounted once at every width. Only three blocks change column, at 1280 px:
	 * the status list and the rings (plain components) and the tasks (a card, which keeps its
	 * last report while it moves).
	 *
	 * In family mode (a display) there is no person: no sentence, no Needs you, no toggle, no
	 * search and no links; `status` (the display's pills) takes the bell's place in the head. With
	 * names off the day is one column of everything.
	 *
	 * A display fits one screen (`fit`): fewer cards per person first (the ones that have ended
	 * leave first), then the photo and the weather's hours, the extras (shopping, the kitchen, the
	 * next days) and the chores, and only last everyone's status (who is home). Its widgets sit
	 * under the day; from 1280 px, when the day's column runs out of room (`shift`), under the
	 * family's column instead. On a tablet held upright (640 to 1023 px) a display keeps the
	 * columns per person and pairs the smaller blocks.
	 */
	let { data, status, fit, band }: CompositionProps = $props();

	const wide = new MediaQuery('(min-width: 1024px)', false);
	const upright = new MediaQuery('(min-width: 640px)', false);
	/**
	 * Three columns (from 1280 px). Everyone's status and the chore rings are glanceable, like the
	 * clock and the weather, so they sit under the weather; the tasks are what needs doing, so
	 * they join Needs you and shopping on the right. Then no column ends far above the others. On
	 * two columns (the atmosphere a band on top) and on a phone they keep their places.
	 */
	const three = new MediaQuery('(min-width: 1280px)', false);
	const threeCols = $derived(three.current);
	/** The day as a column per person: wide screens, and a display from 640 px. */
	const columns = $derived(wide.current || (data.familyMode && upright.current));
	/** Shown once settled and, on a display, once it has been fitted to the screen. */
	const shown = $derived(data.settled && !fit?.hold);
	$effect(() => {
		if (data.settled) fit?.ready();
	});
	const gone = (what: FitDrop) => fit?.drop.has(what) ?? false;
	// The clock's width in em (the display face at 600: a digit ≈ 0.47, the colon ≈ 0.28, each
	// letter of a small day period ≈ 0.17 plus its gap), so its column can cap its size.
	const clockEm = $derived.by(() => {
		const text = formatClock(data.now, data.format);
		const digits = text.replace(/\D/g, '').length;
		const letters = text.replace(/[^\p{L}]/gu, '').length;
		return digits * 0.47 + 0.28 + (letters > 0 ? 0.1 + letters * 0.17 : 0);
	});
	/** Cards per person column (3 is MemberDay's own), and in the one column for everyone. */
	const perPerson = $derived(byTightness(fit, [3, 3, 2, 1]));
	const perAnyone = $derived(byTightness(fit, [9, 6, 4, 3]));
	const dayOf = (items: readonly TimelineItem[], max: number) =>
		fit ? endedFirst(items, max, data.now) : items;
	const app = $derived(data.app);
	const words = $derived(data.words);
	const rowSize = $derived(wide.current ? ('half' as const) : ('wide' as const));
	/** Where things are shared with the family (Quick add), if this viewer may. */
	const share = $derived(app.share());

	const dayTitle = $derived(
		data.evening
			? t('home_tomorrow_title', { weekday: data.tomorrowWeekday })
			: data.hero
				? words.restOfDay
				: t('home_day_title'),
	);
	// With names off (a display) an empty day has no columns to show: the quiet note says it.
	const showDay = $derived(
		data.showsDay &&
			data.shows('day') &&
			!(data.showSteps && data.dayItems.length === 0) &&
			(data.showNames || data.dayItems.length > 0),
	);
	// The phone: people with something get a block each; the others share one line.
	const busy = $derived(data.days.people.filter((p) => p.items.length > 0));
	const free = $derived(
		data.members.filter((m) => !busy.some((p) => p.memberId === m.id)).map((m) => m.displayName),
	);
	const memberOf = (id: string) => data.members.find((m) => m.id === id);
	const choresMeta = (id: string) => {
		const left = data.choresLeftFor(id);
		return left > 0 ? words.status.choresLeft(left) : undefined;
	};
	// With names off (a display) the things for anyone are the whole day, the family's.
	const anyone = $derived({
		displayName: data.showNames ? words.anyone : words.family,
		color: 'var(--ink-soft)',
		anyone: true,
	});
	// Beside things for everyone, an empty person column does not say nothing is planned for them.
	const personWords = (name: string) =>
		data.days.family.length > 0 ? { ...words.day, nothing: words.nothingOwn(name) } : words.day;
	/** One column for everything holds more before "+n more". */
	const anyoneMax = $derived(data.showNames ? (fit ? perPerson : undefined) : perAnyone);
	/** What is ahead has one label for its cards: its menu hides the card when it is the only one. */
	const aheadMenu = $derived(
		data.aheadCards.length === 1 && data.aheadCards[0]
			? data.menuForCard(data.aheadCards[0])
			: undefined,
	);
	const modes = $derived([
		{ value: 'family', label: words.nextUp.family },
		{ value: 'me', label: words.nextUp.me },
	]);
</script>

{#snippet nextDaysList()}
	<ol class="nextdays" data-testid="next-days">
		{#each data.nextDaysItems as item (item.id)}
			{@const timed = groupOf(item) === 1 && item.start !== undefined && !item.nominal}
			{@const color = data.colorOf(item)}
			<li>
				<svelte:element this={item.href ? 'a' : 'div'} href={item.href || undefined} class="row">
					<span class="d font-display">{data.dayLabel(item.day)}</span>
					<span class="w">
						<i style:background-color={color || 'var(--ink-soft)'} aria-hidden="true"></i>
						<b>{item.title}</b>
					</span>
					<small>{timed ? data.clock(item.start as number) : t('home_next_all_day')}</small>
				</svelte:element>
			</li>
		{/each}
	</ol>
{/snippet}

{#snippet glance()}
	<!-- Phones leave the family's statuses out: the stacked day below already says what each one
	     does. What it cannot say (where they are) stands in a strip, when there is something. -->
	{#if data.members.length > 0 && wide.current && data.shows('family')}
		<div class="blk" class:gone={gone('family')} data-drop="family" style:--o="6">
			<TodayBlock block={data.menuFor('family')}>
				<TodaySection title={words.family}>
					<FamilyList people={data.statuses} label={words.family} />
				</TodaySection>
			</TodayBlock>
		</div>
	{:else if data.members.length > 0 && data.hasNotes && data.shows('family')}
		<div class="blk" class:gone={gone('family')} data-drop="family" style:--o="6">
			<TodayBlock block={data.menuFor('family')}>
				<TodaySection title={words.family}>
					<FamilyList people={data.statuses} label={words.family} variant="strip" />
				</TodaySection>
			</TodayBlock>
		</div>
	{/if}

	{#if data.rings.length > 0}
		<div class="blk chores" class:gone={gone('chores')} data-drop="chores" style:--o="8">
			<TodayBlock block={data.menuFor(data.countsBlock)}>
				<TodaySection title={words.choresToday} href={data.countsHref} more={words.chores}>
					<ChoreRings
						rings={data.rings}
						label={words.chores}
						name={(r) => words.choreRing(r.name, r.done, r.total)}
					/>
				</TodaySection>
			</TodayBlock>
		</div>
	{/if}
{/snippet}

<div
	class="bs"
	class:fm={data.familyMode}
	class:shift={fit?.shift}
	class:pending={!shown}
	aria-busy={!shown}
	data-testid="today-body"
	data-settled={shown}
	data-layout="broadsheet"
>
	<!-- ───────────── the atmosphere ───────────── -->
	<div class="col atm" data-column="atmosphere">
		<header class="head" style:--o="1">
			<div class="clockrow">
				{#if data.shows('clock')}
					<div class="time" style:--clock-em={clockEm}>
						<Clock now={data.now} format={data.format} />
						<DateLine now={data.now} format={data.format} heading />
					</div>
				{/if}
				{#if status}
					<div class="status" data-testid="display-status">{@render status()}</div>
				{:else}
					<div class="bell empty:hidden md:hidden"><Slot name="today.head" /></div>
				{/if}
			</div>
			{#if !data.familyMode && data.shows('greeting')}
				<p class="sentence" aria-live="polite" data-testid="day-sentence">
					{#if data.settled}{#each data.sentence as run}{#if run.bold}<b>{run.text}</b
								>{:else}{run.text}{/if}{/each}{:else}&nbsp;{/if}
				</p>
			{/if}
		</header>

		<div class="blk weather empty:hidden" style:--o="2">
			{#each data.atmosphere as c (c.id)}
				<Slot
					name="today.atmosphere"
					contributions={[c]}
					props={{
						form: 'block',
						variant: 'serif',
						strip: gone('atmosphere') ? 'none' : 'tiles',
						familyMode: data.familyMode,
						report: data.atmosphereReporter(c.id),
					}}
				/>
			{/each}
		</div>

		{#if data.photoOfTheDay}
			<div class="blk photo" class:gone={gone('photo')} data-drop="photo" style:--o="15">
				<PhotoTile
					src={data.photoOfTheDay.src}
					label={data.photoOfTheDay.label}
					height={wide.current ? 150 : 180}
				/>
			</div>
		{/if}

		{#if threeCols}{@render glance()}{/if}

		<!-- 1024–1279 px and phones keep search on More; a display has none. -->
		{#if !data.familyMode}
			<div class="blk search"><SearchBox floating /></div>
		{/if}
	</div>

	<!-- ───────────── the day ───────────── -->
	<div class="col plan" data-column="day">
		{#if data.showSteps}
			<div class="blk" style:--o="4">
				<FirstSteps steps={data.steps} onhide={() => data.hideSteps()} />
			</div>
		{/if}

		{#if !data.shows('next')}
			<!-- The next thing is hidden here: nothing takes its place. -->
		{:else if data.hero}
			<div class="blk hero" style:--o="5">
				<NextUpHero
					item={data.hero}
					now={data.now}
					format={data.format}
					words={words.nextUp}
					member={data.heroMember}
					mode={data.mode}
					onmode={(mode: NextUpMode) => void data.setMode(mode)}
					familyMode={data.familyMode}
				/>
			</div>
		{:else if data.nothingForMe}
			<div class="blk none-for-me" style:--o="5" data-testid="next-up-none">
				<p class="font-serif">{words.noneForMe}</p>
				<Segmented
					options={modes}
					value={data.mode}
					label={words.nextUp.toggle}
					size="sm"
					onchange={(mode) => void data.setMode(mode as NextUpMode)}
				/>
			</div>
		{:else if data.showEvening}
			<section class="blk serif-note" style:--o="5" data-testid="evening">
				<h2 class="font-serif">{t('home_evening_title')}</h2>
				<p class="font-serif">{data.eveningText}</p>
			</section>
		{:else if data.quietDay}
			<section class="blk serif-note" style:--o="5" data-testid="quiet-day">
				<h2 class="font-serif">{t('home_quiet_title')}</h2>
				<p class="font-serif">
					{data.quietText}
				</p>
			</section>
		{/if}

		{#if showDay}
			<div class="blk dayblk" style:--o="7">
				<TodayBlock block={data.menuFor('day')}>
					<TodaySection title={dayTitle} href={data.dayHref} more={t('home_day_link')}>
						{#if columns}
							<div class="mcols" data-testid="member-days">
								{#each data.days.people as person (person.memberId)}
									{@const m = memberOf(person.memberId)}
									{#if m}
										<MemberDay
											member={m}
											items={dayOf(person.items, perPerson)}
											now={data.now}
											format={data.format}
											words={personWords(m.displayName)}
											nextId={data.hero?.id ?? null}
											meta={choresMeta(m.id)}
											max={fit ? perPerson : undefined}
										/>
									{/if}
								{/each}
								{#if data.days.family.length > 0}
									<MemberDay
										member={anyone}
										items={dayOf(data.days.family, anyoneMax ?? 3)}
										now={data.now}
										format={data.format}
										words={words.day}
										nextId={data.hero?.id ?? null}
										max={anyoneMax}
										flow={!data.showNames}
									/>
								{/if}
							</div>
						{:else}
							<div class="mstack" data-testid="member-days">
								{#each busy as person (person.memberId)}
									{@const m = memberOf(person.memberId)}
									{#if m}
										<MemberDay
											member={m}
											items={person.items}
											now={data.now}
											format={data.format}
											words={words.day}
											variant="stack"
											nextId={data.hero?.id ?? null}
										/>
									{/if}
								{/each}
								{#if data.days.family.length > 0}
									<MemberDay
										member={anyone}
										items={data.days.family}
										now={data.now}
										format={data.format}
										words={words.day}
										variant="stack"
										nextId={data.hero?.id ?? null}
									/>
								{/if}
								{#if free.length > 0}
									<p class="free font-serif">
										{data.days.family.length > 0
											? words.nothingOwn(words.names(free))
											: words.nothingFor(words.names(free))}
									</p>
								{/if}
							</div>
						{/if}
					</TodaySection>
				</TodayBlock>
			</div>
		{/if}

		{#each data.dayCards as c (c.id)}
			<div class="blk empty:hidden" style:--o="9">
				<TodayBlock block={data.menuForCard(c)}>
					<Slot name="dashboard.card" contributions={[c]} props={data.propsFor(c, 'wide')} />
				</TodayBlock>
			</div>
		{/each}

		{#each data.rowCards.filter((c) => !(threeCols && c.todo)) as c (c.id)}
			<div class="blk empty:hidden" style:--o="10">
				<TodayBlock block={data.menuForCard(c)}>
					<Slot name="dashboard.card" contributions={[c]} props={data.propsFor(c, rowSize)} />
				</TodayBlock>
			</div>
		{/each}

		{#if data.showNext}
			<div class="blk" class:gone={gone('extras')} data-drop="extras" style:--o="11">
				<TodayBlock block={data.menuFor('nextDays')}>
					<TodaySection title={t('home_next_title')} href={data.dayHref} more={t('home_next_link')}>
						{@render nextDaysList()}
					</TodaySection>
				</TodayBlock>
			</div>
		{/if}

		<section
			class="blk {data.aheadTotal === 0 ? 'hidden' : ''}"
			class:gone={gone('extras')}
			data-drop="extras"
			style:--o="12"
			aria-labelledby="ahead-title"
		>
			<TodayBlock block={aheadMenu}>
				<div class="labelrow">
					<h2 id="ahead-title" class="label">{t('home_ahead_title')}</h2>
					<TodayBlockMenu />
				</div>
			</TodayBlock>
			<div class="ahead">
				{#each data.aheadCards as c (c.id)}
					<TodayBlock block={data.menuForCard(c)}>
						<Slot name="dashboard.card" contributions={[c]} props={data.propsFor(c, 'wide')} />
					</TodayBlock>
				{/each}
			</div>
		</section>

		{#if data.doneLine}
			<div class="blk" style:--o="14"><QuietLine text={data.doneLine} testid="done-line" /></div>
		{/if}
	</div>

	<!-- ───────────── the family ───────────── -->
	<div class="col fam" data-column="family">
		<section
			class="blk {data.needsTotal === 0 ? 'hidden' : ''}"
			style:--o="3"
			aria-labelledby="needs-title"
			data-testid="needs-you"
		>
			<div class="labelrow">
				<span class="dot" aria-hidden="true"></span>
				<h2 id="needs-title" class="label">
					{t('home_needs_title')}<span class="count">{data.needsTotal}</span>
				</h2>
				<!-- The link fits what is listed: none for the AI setup row alone. -->
				{#if share && data.needsCardsTotal > 0}
					<a href={share.path} class="more">{t('home_needs_link')}</a>
				{/if}
				<TodayBlock block={data.menuFor('needs')}><TodayBlockMenu /></TodayBlock>
			</div>
			<div class="needs">
				{#each data.needsCards as c (c.id)}
					<Slot name="dashboard.card" contributions={[c]} props={data.propsFor(c, 'wide')} />
				{/each}
				{#if data.showAiRow}
					<TodayRow
						variant="needs"
						title={t('home_ai_row_title')}
						meta={t('home_ai_missing_text')}
						wrap
						href="/settings/ai"
					>
						{#snippet trailing()}
							<button type="button" class="ghost" onclick={() => data.dismissAi()}
								>{t('home_ai_row_dismiss')}</button
							>
							<a href="/settings/ai" class="soft">{t('home_ai_missing_action')}</a>
						{/snippet}
					</TodayRow>
				{/if}
			</div>
		</section>

		{#if !threeCols}{@render glance()}{/if}

		{#each data.glanceCards as c (c.id)}
			<div class="blk empty:hidden" class:gone={gone('extras')} data-drop="extras" style:--o="8">
				<TodayBlock block={data.menuForCard(c)}>
					<Slot
						name="dashboard.card"
						contributions={[c]}
						props={data.propsFor(c, 'wide', 'glance')}
					/>
				</TodayBlock>
			</div>
		{/each}

		{#if threeCols}
			{#each data.todoCards as c (c.id)}
				<div class="blk empty:hidden" style:--o="10">
					<TodayBlock block={data.menuForCard(c)}>
						<Slot name="dashboard.card" contributions={[c]} props={data.propsFor(c, rowSize)} />
					</TodayBlock>
				</div>
			{/each}
		{/if}

		{#if data.meals.length > 0}
			<div class="blk" class:gone={gone('extras')} data-drop="extras" style:--o="13">
				<TodayBlock block={data.menuFor(data.mealsBlock?.id ?? '')}>
					<TodaySection title={words.kitchen}>
						<ul class="meals">
							{#each data.meals as meal (meal.id)}
								<li>
									<svelte:element
										this={meal.href ? 'a' : 'span'}
										href={meal.href || undefined}
										class="meal">{meal.title}</svelte:element
									>
								</li>
							{/each}
						</ul>
					</TodaySection>
				</TodayBlock>
			</div>
		{/if}

		<!-- The capture box is a desktop shortcut (phones have the Quick add tab). -->
		{#if data.showCapture}
			<div class="blk max-md:hidden" style:--o="16">
				<TodaySection title={t('home_capture_title')}>
					<Slot name="today.capture" />
				</TodaySection>
			</div>
		{/if}

		{#if data.quiet}
			<div class="blk" style:--o="17"><QuietLine text={data.quiet} /></div>
		{/if}
		{#if data.footCards.length > 0}
			<div class="blk foot" style:--o="18" data-testid="today-foot">
				{#each data.footCards as c (c.id)}
					<TodayBlock block={data.menuForCard(c)}>
						<Slot name="dashboard.card" contributions={[c]} props={data.propsFor(c, 'wide')} />
					</TodayBlock>
				{/each}
			</div>
		{/if}
	</div>

	{#if band}
		<!-- A display's widgets: after the day, or from 1280 px under the column with room. -->
		<div class="widgets" style:--o="19">{@render band()}</div>
	{/if}
</div>

<style>
	/* The phone first: one column, the blocks in the order of `--o`. */
	.bs {
		--ramp-clock: 3.5rem;
		--ramp-date: 1.5rem;
		--ramp-countdown: 5.25rem;
		--ramp-hero: 2.375rem;
		--ramp-big: 3.5rem;
		--ramp-sentence: 1.125rem;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 24px;
		max-width: 88rem;
	}
	.col {
		display: contents;
	}
	.col > * {
		order: var(--o, 50);
		min-width: 0;
	}
	/* Until the page has settled only the head shows; the rest is mounted, hidden. */
	.pending {
		visibility: hidden;
	}
	.pending .head {
		visibility: visible;
	}
	.blk {
		transition: opacity 150ms;
	}
	.pending .blk {
		opacity: 0;
	}
	@media (prefers-reduced-motion: reduce) {
		.blk {
			transition: none;
		}
	}

	/* ── the head ── */
	.head {
		display: grid;
		gap: 10px;
		min-width: 0;
	}
	.clockrow {
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}
	.time {
		display: grid;
		gap: 6px;
		min-width: 0;
		flex: 1;
	}
	/* A display's pills: beside the clock when there is room, else under it. The clock keeps its
	   own width, so a pill that does not fit beside it wraps instead of lying over the digits. */
	/* The clock never runs out of its column: a 12-hour clock with its day period is wider than
	   the atmosphere column at the ramp's size, so its width in em caps its size. Not beside a
	   display's pills, which wrap under the clock instead. */
	.clockrow:not(:has(.status)) > .time {
		container-type: inline-size;
	}
	.time :global(.clock) {
		font-size: min(var(--ramp-clock), calc(100cqi / var(--clock-em, 2.6)));
	}
	.clockrow:has(.status) {
		flex-wrap: wrap;
	}
	.clockrow:has(.status) > .time {
		flex: 1 1 auto;
		min-width: min-content;
	}
	.status {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.status:empty {
		display: none;
	}
	.sentence {
		max-width: 36ch;
		font-size: 15px;
		line-height: 1.4;
		color: var(--ink-soft);
	}
	.sentence b {
		font-weight: 700;
		color: var(--ink);
	}
	.search {
		display: none;
	}

	/* ── the day ── */
	.serif-note {
		display: grid;
		gap: 6px;
		max-width: 34ch;
	}
	.serif-note h2,
	.serif-note p,
	.none-for-me p {
		font-size: calc(var(--ramp-sentence) * 1.2);
		font-style: italic;
		font-weight: 400;
		line-height: 1.2;
		color: var(--ink);
	}
	.serif-note p {
		color: var(--ink-soft);
	}
	.none-for-me {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.mcols {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(6.5rem, 1fr));
		gap: 18px 14px;
	}
	.mstack {
		display: grid;
		gap: 14px;
	}
	.free {
		padding-inline-start: 15px;
		border-inline-start: 3px solid var(--line);
		font-size: 16px;
		font-style: italic;
		line-height: 1.25;
		color: var(--ink-soft);
	}
	.nextdays {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.nextdays li + li {
		border-top: 1px solid var(--line);
	}
	.nextdays .row {
		display: grid;
		grid-template-columns: 4.5rem minmax(0, 1fr) auto;
		align-items: center;
		gap: 10px;
		min-height: 44px;
		padding: 0 2px;
		border-radius: 8px;
		color: var(--ink);
		text-decoration: none;
	}
	.nextdays a.row:hover b {
		text-decoration: underline;
	}
	.nextdays .d {
		font-size: 17px;
		font-weight: 600;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: var(--ink-soft);
	}
	.nextdays .w {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.nextdays i {
		flex: none;
		width: 10px;
		height: 10px;
		border-radius: 50%;
	}
	.nextdays b {
		overflow: hidden;
		font-size: 14px;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.nextdays small {
		font-size: 13px;
		color: var(--ink-soft);
		white-space: nowrap;
	}
	.ahead {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: 8px 16px;
	}

	/* ── the family ── */
	.label {
		min-width: 0;
		overflow: hidden;
		font-size: var(--ramp-label, 13px);
		font-weight: 700;
		letter-spacing: var(--ramp-label-tracking, 0.06em);
		text-overflow: ellipsis;
		text-transform: uppercase;
		white-space: nowrap;
		color: var(--ink-soft);
	}
	.labelrow {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-height: 24px;
		margin-bottom: 10px;
	}
	.dot {
		flex: none;
		align-self: center;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--attention);
	}
	.count {
		margin-inline-start: 8px;
		font-weight: 600;
		letter-spacing: 0;
	}
	.more {
		flex: none;
		margin-inline-start: auto;
		font-size: 12px;
		font-weight: 700;
		color: var(--ink-soft);
	}
	.more:hover {
		color: var(--ink);
	}
	.needs {
		overflow: hidden;
		border-inline-start: 3px solid var(--attention);
		border-radius: 14px;
		background: var(--surface);
		box-shadow: var(--shadow-lit);
	}
	.needs > :global(* + *) {
		border-top: 1px solid var(--line);
	}
	.needs .ghost,
	.needs .soft {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 12px;
		border-radius: 8px;
		font-size: 14px;
		font-weight: 700;
	}
	.needs .ghost {
		color: var(--ink-soft);
	}
	.needs .ghost:hover {
		background: var(--idle);
	}
	.needs .soft {
		padding: 0 16px;
		background: var(--idle);
		color: var(--ink);
	}
	.meals {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.meals li + li {
		border-top: 1px solid var(--line);
	}
	.meals .meal {
		display: flex;
		align-items: center;
		min-height: 36px;
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
		text-decoration: none;
	}
	.meals a.meal:hover {
		text-decoration: underline;
	}
	.foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 20px;
	}

	/* The bell sits at the end of the head, also when the clock is hidden. */
	.bell {
		margin-inline-start: auto;
	}

	/* A display leaves out what does not fit its screen. */
	.gone {
		display: none !important;
	}
	.widgets {
		display: contents;
	}

	/* A display held upright (640 to 1023 px): the head and the weather side by side, the day as
	   columns, the smaller blocks in pairs, at the type of 1024 px. */
	@media (min-width: 640px) and (max-width: 1023.98px) {
		.bs.fm {
			--ramp-clock: 5.5rem;
			--ramp-date: 1.75rem;
			--ramp-countdown: 6.5rem;
			--ramp-hero: 2.75rem;
			--ramp-big: 3.25rem;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			grid-auto-flow: row dense;
			gap: 28px 32px;
			align-items: start;
		}
		.fm .col > * {
			grid-column: 1 / -1;
		}
		.fm .atm > .head,
		.fm .atm > .weather,
		.fm .atm > .photo,
		.fm .fam > * {
			grid-column: auto;
		}
	}

	/* From 1024 px: the atmosphere is a band on top, the day and the family share the width. */
	@media (min-width: 1024px) {
		.bs {
			--ramp-clock: 5.5rem;
			--ramp-date: 1.75rem;
			--ramp-countdown: 6.5rem;
			--ramp-hero: 2.75rem;
			--ramp-big: 3.25rem;
			--ramp-sentence: 1.125rem;
			grid-template-columns: minmax(0, 1fr) 18.75rem;
			gap: 32px 28px;
			align-items: start;
		}
		.col {
			display: grid;
			grid-template-columns: minmax(0, 1fr);
			align-content: start;
			gap: 26px;
			min-width: 0;
		}
		.col > * {
			order: 0;
		}
		.atm {
			grid-column: 1 / -1;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr) auto;
			align-items: start;
			gap: 28px;
		}
		.atm .photo {
			width: 13rem;
		}
		.plan {
			grid-column: 1;
		}
		.fam {
			grid-column: 2;
		}
	}

	/* What Today hides leaves no empty column (show or hide only: the columns stay the style's).
	   The head without the clock and the sentence is only the phone's bell; a column with nothing
	   to show gives its room to the others. */
	@media (min-width: 768px) {
		.head:not(:has(.time, .sentence, .status)) {
			display: none;
		}
	}
	@media (min-width: 1024px) {
		.bs:not(
				:has(
					> .atm > .head :is(.time, .sentence, .status),
					> .atm > .blk:not(.search, .gone, :empty)
				)
			)
			> .atm {
			display: none;
		}
	}
	@media (min-width: 1024px) and (max-width: 1279.98px) {
		.bs:not(.fm):not(:has(> .fam > :not(.hidden, .gone, :empty))),
		.bs:not(.fm):not(:has(> .plan > :not(.hidden, .gone, :empty))) {
			grid-template-columns: minmax(0, 1fr);
		}
		.bs:not(.fm):not(:has(> .plan > :not(.hidden, .gone, :empty))) > .fam {
			grid-column: 1;
		}
	}

	/* A display from 1024 to 1279 px: the atmosphere on top, the next thing beside the family's
	   blocks, the day across the whole width (a column per person on one row), and the smaller
	   blocks in pairs under it. */
	@media (min-width: 1024px) and (max-width: 1279.98px) {
		.bs.fm {
			grid-auto-flow: row dense;
		}
		.fm .plan,
		.fm .fam {
			display: contents;
		}
		.fm .plan > *,
		.fm .fam > * {
			order: var(--o, 50);
		}
		.fm .atm {
			order: 0;
		}
		.fm .plan > .dayblk {
			grid-column: 1 / -1;
		}
	}

	/* From 1280 px: three columns, the atmosphere on the left (the design doc's 280 · 1fr · 300). */
	@media (min-width: 1280px) {
		.bs {
			--ramp-clock: 7.75rem;
			--ramp-date: 2.125rem;
			--ramp-countdown: 8rem;
			--ramp-hero: 3.375rem;
			--ramp-big: 4rem;
			--ramp-sentence: 1.25rem;
			grid-template-columns: 17.5rem minmax(0, 1fr) 18.75rem;
		}
		.atm {
			grid-column: 1;
			grid-template-columns: minmax(0, 1fr);
			gap: 24px;
		}
		.atm .photo {
			width: auto;
		}
		.search {
			display: block;
		}
		.plan {
			grid-column: 2;
		}
		.fam {
			grid-column: 3;
		}

		/* Without the atmosphere, the day and the family take its room. */
		.bs:not(
			:has(> .atm > .head :is(.time, .sentence, .status), > .atm > .blk:not(.search, .gone, :empty))
		) {
			grid-template-columns: minmax(0, 1fr) 18.75rem;
		}
		.bs:not(
				:has(
					> .atm > .head :is(.time, .sentence, .status),
					> .atm > .blk:not(.search, .gone, :empty)
				)
			)
			> .plan {
			grid-column: 1;
		}
		.bs:not(
				:has(
					> .atm > .head :is(.time, .sentence, .status),
					> .atm > .blk:not(.search, .gone, :empty)
				)
			)
			> .fam {
			grid-column: 2;
		}
		/* Without the family column, the day takes its room. */
		.bs:not(:has(> .fam > :not(.hidden, .gone, :empty))) {
			grid-template-columns: 17.5rem minmax(0, 1fr);
		}
		/* Without the day, the family column takes its room. */
		.bs:not(:has(> .plan > :not(.hidden, .gone, :empty))) {
			grid-template-columns: 17.5rem minmax(0, 1fr);
		}
		.bs:not(:has(> .plan > :not(.hidden, .gone, :empty))) > .fam {
			grid-column: 2;
		}
		/* Only one column with something: it takes the whole width. */
		.bs:not(
				:has(
					> .atm > .head :is(.time, .sentence, .status),
					> .atm > .blk:not(.search, .gone, :empty)
				)
			):not(:has(> .fam > :not(.hidden, .gone, :empty))),
		.bs:not(
				:has(
					> .atm > .head :is(.time, .sentence, .status),
					> .atm > .blk:not(.search, .gone, :empty)
				)
			):not(:has(> .plan > :not(.hidden, .gone, :empty))),
		.bs:not(:has(> .plan > :not(.hidden, .gone, :empty))):not(
				:has(> .fam > :not(.hidden, .gone, :empty))
			) {
			grid-template-columns: minmax(0, 1fr);
		}
		.bs:not(
				:has(
					> .atm > .head :is(.time, .sentence, .status),
					> .atm > .blk:not(.search, .gone, :empty)
				)
			):not(:has(> .plan > :not(.hidden, .gone, :empty)))
			> .fam {
			grid-column: 1;
		}
		.bs:not(:has(> .plan > :not(.hidden, .gone, :empty))):not(
				:has(> .fam > :not(.hidden, .gone, :empty))
			)
			> .atm {
			grid-column: 1;
		}
	}

	/* A display from 1280 px: its widgets on a second row under one column, which the other
	   columns span: under the day, or (`shift`) under the family's column, where a display has
	   only a few small blocks. Counted from the end, so it holds whichever columns show. */
	@media (min-width: 1280px) {
		.bs.fm {
			grid-template-rows: auto 1fr;
			row-gap: 0;
		}
		.fm > .col {
			grid-row: 1 / span 2;
		}
		.fm > .widgets {
			display: grid;
			grid-row: 2;
			grid-column: -3 / -2;
			min-width: 0;
		}
		.fm > .widgets:has(:global(.widget:not(.gone):not(:empty))) {
			padding-top: 26px;
		}
		.bs.fm:not(.shift) > .plan,
		.bs.fm.shift > .fam {
			grid-row: 1;
		}
		.fm.shift > .widgets {
			grid-column: -2 / -1;
		}
		/* Without the family's column the day is the last one: the widgets stay under it. */
		.bs.fm:not(:has(> .fam > :not(.hidden, .gone, :empty))) > .plan {
			grid-row: 1;
		}
		.bs.fm:not(:has(> .fam > :not(.hidden, .gone, :empty))) > .widgets {
			grid-column: -2 / -1;
		}
	}
</style>
