<script lang="ts">
	import {
		ChoreRings,
		Clock,
		DateLine,
		MemberDay,
		type MemberDayWords,
		formatClock,
		isTimed,
		NextUpHero,
		type NextUpMode,
		PhotoTile,
		QuietLine,
		Ring,
		Segmented,
		TodayBlock,
		TodayBlockMenu,
		TodayRow,
		TodaySection,
	} from '@famos/ui/famos';
	import Slot from '@famos/ui/slot';
	import type { TimelineItem } from '@famos/ui/slots';
	import { groupOf } from '@famos/ui/timeline';
	import { MediaQuery } from 'svelte/reactivity';
	import FirstSteps from '#lib/FirstSteps.svelte';
	import { t } from '#lib/i18n.svelte.js';
	import SearchBox from '#lib/SearchBox.svelte';
	import { byTightness, type CompositionProps, type FitDrop, endedFirst } from './display-fit.js';

	/**
	 * Wall: Today in one face at a large scale.
	 * From 1280 px two columns `400px 1fr`: the atmosphere (the clock, the date, the weather as a
	 * number and bars, the board, the photo) and the day (Needs you, the next thing on the accent
	 * with its countdown ring, "Who, next" as a row per person with their chores as a ring, and
	 * three tiles: shopping as a number, what is ahead or the next days, the kitchen). From 1024 px
	 * the clock and the weather share a band on top and the rest follows in one column; below
	 * 1024 px everything stacks in the order of `--o` and the rows drop the name column.
	 *
	 * Purely presentational: everything comes from `TodayData`, which also says when the page has
	 * settled. Until then only the head shows; the rest is mounted but hidden so the cards can
	 * load and report, and the page composes once. The columns are CSS: a card is mounted once at
	 * every width.
	 *
	 * In family mode (a display) there is no person: no sentence, no Needs you, no toggle, no
	 * search and no links; `status` (the display's pills) takes the bell's place in the head. With
	 * names off there are no rows per person: the rest of the day is one list (what is still to
	 * come, the hero's item aside) and the chores' total joins the tiles.
	 *
	 * A display fits one screen (`fit`) with its two columns: the left one holds the atmosphere,
	 * the right one the day. It gives up the list's length first (names off), then the
	 * atmosphere (the photo, the weather's bars), the extras (shopping, the kitchen, the next
	 * days) and the chores' total; with names on the chores stay as each row's ring. On a tablet
	 * held upright (640 to 1023 px) a display pairs the head with the weather and keeps the names.
	 */
	let { data, status, fit, band }: CompositionProps = $props();

	const wide = new MediaQuery('(min-width: 1024px)', false);
	const upright = new MediaQuery('(min-width: 640px)', false);
	/** The rows keep their name column: wide screens, and a display from 640 px. */
	const named = $derived(wide.current || (data.familyMode && upright.current));
	/** Shown once settled and, on a display, once it has been fitted to the screen. */
	const shown = $derived(data.settled && !fit?.hold);
	$effect(() => {
		if (data.settled) fit?.ready();
	});
	const gone = (what: FitDrop) => fit?.drop.has(what) ?? false;
	const twoColumns = new MediaQuery('(min-width: 1280px)', false);
	const app = $derived(data.app);
	const words = $derived(data.words);
	/** Where things are shared with the family (Quick add), if this viewer may. */
	const share = $derived(app.share());

	const whoTitle = $derived(
		data.evening
			? t('home_tomorrow_title', { weekday: data.tomorrowWeekday })
			: !data.showNames
				? data.hero
					? words.restOfDay
					: t('home_day_title')
				: words.whoNext,
	);
	// In the evening the rows are tomorrow's: a person with nothing has nothing planned.
	const dayWords = $derived<MemberDayWords>(
		data.evening ? { ...words.day, nothingMore: words.day.nothing } : words.day,
	);
	// With names off (a display) the rest of the day is one list: all day, then what is to come.
	const DAY_LIST_MAX = 6;
	const listMax = $derived(byTightness(fit, [DAY_LIST_MAX, 5, 4, 3]));
	const dayList = $derived(
		data.showNames
			? []
			: data.days.family.filter(
					(item) =>
						item.id !== data.hero?.id &&
						(!isTimed(item) || (item.end ?? item.start ?? 0) > data.now),
				),
	);
	const showWho = $derived(
		data.showsDay &&
			data.shows('day') &&
			!(data.showSteps && data.dayItems.length === 0) &&
			(data.showNames ? data.members.length > 0 : dayList.length > 0),
	);
	const itemsOf = (id: string): readonly TimelineItem[] =>
		data.days.people.find((p) => p.memberId === id)?.items ?? [];
	const listed = $derived(fit ? endedFirst(dayList, listMax, data.now) : dayList);
	const ringOf = (id: string) => data.rings.find((r) => r.id === id);
	const choresMeta = (id: string | null) => {
		const left = data.choresLeftFor(id);
		return left > 0 ? words.status.choresLeft(left) : undefined;
	};
	const anyone = $derived({ displayName: words.anyone, color: 'var(--ink-soft)', anyone: true });
	const anyoneRing = $derived(ringOf('anyone'));
	const showAnyone = $derived(data.days.family.length > 0 || anyoneRing !== undefined);
	// The clock never runs out of its column: its width in em (Figtree 800 at −0.05 em: a digit
	// ≈ 0.58, the colon ≈ 0.27, a small day period ≈ 0.5) caps its size by the column's width.
	const clockEm = $derived.by(() => {
		const text = formatClock(data.now, data.format);
		const digits = text.replace(/\D/g, '').length;
		return digits * 0.58 + 0.27 + (/\p{L}/u.test(text) ? 0.5 : 0);
	});
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

{#snippet choreRing(ring: (typeof data.rings)[number] | undefined)}
	{#if ring}
		<Ring
			done={ring.done}
			total={ring.total}
			color={ring.color}
			size={44}
			dim={ring.total === 0}
			name={words.choreRing(ring.name, ring.done, ring.total)}
		/>
	{/if}
{/snippet}

<div
	class="wall"
	class:fm={data.familyMode}
	class:shift={fit?.shift}
	class:pending={!shown}
	aria-busy={!shown}
	data-testid="today-body"
	data-settled={shown}
	data-layout="wall"
>
	<!-- ───────────── the atmosphere ───────────── -->
	<div class="col atm" data-column="atmosphere">
		<header class="head" style:--o="1">
			<div class="clockrow">
				{#if data.shows('clock')}
					<div class="time" style:--clock-em={clockEm}>
						<Clock now={data.now} format={data.format} />
						<DateLine now={data.now} format={data.format} variant="plain" heading />
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
						variant: 'plain',
						strip: gone('atmosphere') ? 'none' : 'bars',
						familyMode: data.familyMode,
						report: data.atmosphereReporter(c.id),
					}}
				/>
			{/each}
		</div>

		<!-- The board's papers (and other rows of the notes band) under the weather. -->
		{#each data.rowCards as c (c.id)}
			<div class="blk empty:hidden" style:--o="11">
				<TodayBlock block={data.menuForCard(c)}
					><Slot
						name="dashboard.card"
						contributions={[c]}
						props={data.propsFor(c, twoColumns.current ? 'half' : 'wide')}
					/></TodayBlock
				>
			</div>
		{/each}

		{#if data.photoOfTheDay}
			<div class="blk photo" class:gone={gone('photo')} style:--o="12">
				<PhotoTile
					src={data.photoOfTheDay.src}
					label={data.photoOfTheDay.label}
					height={wide.current ? 150 : 180}
				/>
			</div>
		{/if}

		<!-- 1024–1279 px and phones keep search on More; a display has none. -->
		{#if !data.familyMode}
			<div class="blk search"><SearchBox floating /></div>
		{/if}
	</div>

	<!-- ───────────── the day ───────────── -->
	<div class="col plan" data-column="day">
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
				{#if share}
					<a href={share.path} class="more">{t('home_needs_link')}</a>
				{/if}
				<TodayBlock block={data.menuFor('needs')}><TodayBlockMenu /></TodayBlock>
			</div>
			<div class="needs">
				{#each data.needsCards as c (c.id)}
					<TodayBlock block={data.menuForCard(c)}
						><Slot
							name="dashboard.card"
							contributions={[c]}
							props={data.propsFor(c, 'wide')}
						/></TodayBlock
					>
				{/each}
				{#if data.showAiRow}
					<TodayRow
						variant="needs"
						title={t('home_ai_row_title')}
						meta={t('home_ai_missing_text')}
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
					variant="plain"
					countdownVariant="ring"
					ringSize={wide.current ? 128 : 92}
				/>
			</div>
		{:else if data.nothingForMe}
			<div class="blk none-for-me" style:--o="5" data-testid="next-up-none">
				<p>{words.noneForMe}</p>
				<Segmented
					options={modes}
					value={data.mode}
					label={words.nextUp.toggle}
					size="sm"
					onchange={(mode) => void data.setMode(mode as NextUpMode)}
				/>
			</div>
		{:else if data.showEvening}
			<section class="blk note" style:--o="5" data-testid="evening">
				<h2>{t('home_evening_title')}</h2>
				<p>{data.eveningText}</p>
			</section>
		{:else if data.quietDay}
			<section class="blk note" style:--o="5" data-testid="quiet-day">
				<h2>{t('home_quiet_title')}</h2>
				<p>
					{data.quietText}
				</p>
			</section>
		{/if}

		{#if showWho}
			<div class="blk who-blk" style:--o="7">
				<TodayBlock block={data.menuFor('day')}>
					<TodaySection title={whoTitle} href={data.dayHref} more={t('home_day_link')}>
						{#if data.showNames}
							<div class="who" data-testid="member-days">
								{#each data.members as m (m.id)}
									{@const ring = ringOf(m.id)}
									<MemberDay
										member={m}
										items={itemsOf(m.id)}
										now={data.now}
										format={data.format}
										words={dayWords}
										variant="row"
										meta={choresMeta(m.id)}
										note={data.notes[m.id]}
										showName={named}
									>
										{#snippet trailing()}{@render choreRing(ring)}{/snippet}
									</MemberDay>
								{/each}
								{#if showAnyone}
									<MemberDay
										member={anyone}
										items={data.days.family}
										now={data.now}
										format={data.format}
										words={dayWords}
										variant="row"
										meta={choresMeta(null)}
										showName={named}
									>
										{#snippet trailing()}{@render choreRing(anyoneRing)}{/snippet}
									</MemberDay>
								{/if}
							</div>
						{:else}
							<ol class="daylist" data-testid="day-list">
								{#each listed.slice(0, listMax) as item (item.id)}
									<li>
										<time
											>{isTimed(item) ? data.clock(item.start as number) : words.day.allDay}</time
										>
										<span class="t">
											<b>{item.title}</b>
											{#if item.location}<small>{item.location}</small>{/if}
										</span>
									</li>
								{/each}
							</ol>
							{#if listed.length > listMax}
								<span class="daymore">{words.day.more(listed.length - listMax)}</span>
							{/if}
						{/if}
					</TodaySection>
				</TodayBlock>
			</div>
		{/if}

		{#each data.dayCards as c (c.id)}
			<div class="blk empty:hidden" style:--o="9">
				<TodayBlock block={data.menuForCard(c)}
					><Slot
						name="dashboard.card"
						contributions={[c]}
						props={data.propsFor(c, 'wide')}
					/></TodayBlock
				>
			</div>
		{/each}

		<!-- The tiles: shopping as a number, what is ahead (the next days on a light day), the kitchen. -->
		<div class="blk tiles" style:--o="10" data-testid="wall-tiles">
			<!-- Names off (a display): the chores' total, as there are no rows to carry rings. -->
			{#if !data.showNames && data.rings.length > 0}
				<div class="tile" class:gone={gone('chores')}>
					<TodayBlock block={data.menuFor(data.countsBlock)}>
						<TodaySection title={words.choresToday}>
							<ChoreRings
								rings={data.rings}
								label={words.chores}
								name={(r) => words.choreRing(r.name, r.done, r.total)}
							/>
						</TodaySection>
					</TodayBlock>
				</div>
			{/if}

			{#each data.glanceCards as c (c.id)}
				<div class="tile empty:hidden" class:gone={gone('extras')}>
					<TodayBlock block={data.menuForCard(c)}
						><Slot
							name="dashboard.card"
							contributions={[c]}
							props={data.propsFor(c, 'wide', 'glance')}
						/></TodayBlock
					>
				</div>
			{/each}

			{#if data.showNext}
				<div class="tile" class:gone={gone('extras')}>
					<TodayBlock block={data.menuFor('nextDays')}>
						<TodaySection
							title={t('home_next_title')}
							href={data.dayHref}
							more={t('home_next_link')}
						>
							<ol class="nextdays" data-testid="next-days">
								{#each data.nextDaysItems as item (item.id)}
									{@const timed = groupOf(item) === 1 && item.start !== undefined && !item.nominal}
									{@const color = data.colorOf(item)}
									<li>
										<svelte:element
											this={item.href ? 'a' : 'div'}
											href={item.href || undefined}
											class="row"
										>
											<span class="d">{data.dayLabel(item.day)}</span>
											<span class="w">
												<i style:background-color={color || 'var(--ink-soft)'} aria-hidden="true"
												></i>
												<b>{item.title}</b>
											</span>
											<small
												>{timed ? data.clock(item.start as number) : t('home_next_all_day')}</small
											>
										</svelte:element>
									</li>
								{/each}
							</ol>
						</TodaySection>
					</TodayBlock>
				</div>
			{/if}

			<section
				class="tile {data.aheadTotal === 0 ? 'hidden' : ''}"
				class:gone={gone('extras')}
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
						<TodayBlock block={data.menuForCard(c)}
							><Slot
								name="dashboard.card"
								contributions={[c]}
								props={data.propsFor(c, 'wide')}
							/></TodayBlock
						>
					{/each}
				</div>
			</section>

			{#if data.meals.length > 0}
				<div class="tile" class:gone={gone('extras')}>
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
		</div>

		{#if data.doneLine}
			<div class="blk" style:--o="14"><QuietLine text={data.doneLine} testid="done-line" /></div>
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
					<TodayBlock block={data.menuForCard(c)}
						><Slot
							name="dashboard.card"
							contributions={[c]}
							props={data.propsFor(c, 'wide')}
						/></TodayBlock
					>
				{/each}
			</div>
		{/if}
		{#if band}
			<!-- A display's widgets: the band is the grid item itself (gone when it has nothing). -->
			<div class="widgets" style:--o="19">{@render band()}</div>
		{/if}
	</div>
</div>

<style>
	/* The phone first: one column, the blocks in the order of `--o`. The sizes at 1280 px and up
	   are the style's ramp (styles.css); narrower widths set their own. */
	.wall {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 22px;
		max-width: 88rem;
	}
	@media (max-width: 1023.98px) {
		.wall {
			--ramp-clock: 4.5rem;
			--ramp-date: 1.125rem;
			--ramp-countdown: 4.25rem;
			--ramp-hero: 1.875rem;
			--ramp-big: 3.25rem;
		}
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
		align-content: start;
		gap: 8px;
		min-width: 0;
	}
	.clockrow {
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}
	/* A display's pills go under the clock: the clock grows to fill its box, so beside it a pill
	   would only shrink the clock. */
	.clockrow:has(.status) {
		flex-wrap: wrap;
	}
	.clockrow:has(.status) > .time {
		flex-basis: 100%;
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
	.time {
		display: grid;
		gap: 10px;
		min-width: 0;
		flex: 1;
		container-type: inline-size;
	}
	.time :global(.clock) {
		font-size: min(var(--ramp-clock), calc(100cqi / var(--clock-em, 2.6)));
		margin-inline-start: -0.04em;
		font-weight: 800;
		letter-spacing: -0.05em;
		line-height: 0.82;
	}
	.sentence {
		max-width: 40ch;
		font-size: 13px;
		font-weight: 600;
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
	.note {
		display: grid;
		gap: 4px;
		max-width: 34ch;
	}
	.note h2,
	.note p,
	.none-for-me p {
		font-size: 22px;
		font-weight: 600;
		letter-spacing: -0.01em;
		line-height: 1.25;
		color: var(--ink);
	}
	.note p {
		font-weight: 500;
		color: var(--ink-soft);
	}
	.none-for-me {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	/* Names off: the rest of the day as one list, the time large as in the rows. */
	.daylist {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.daylist li {
		display: grid;
		grid-template-columns: 9.5rem minmax(0, 1fr);
		align-items: center;
		gap: 14px;
		min-height: 56px;
		padding: 6px 0;
	}
	.daylist li + li {
		border-top: 1px solid var(--line);
	}
	.daylist time {
		font-size: 26px;
		font-weight: 800;
		letter-spacing: -0.03em;
		line-height: 1;
		white-space: nowrap;
	}
	.daylist .t {
		display: grid;
		min-width: 0;
		line-height: 1.2;
	}
	.daylist b {
		overflow: hidden;
		font-size: 17px;
		font-weight: 700;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.daylist small {
		overflow: hidden;
		font-size: 13px;
		color: var(--ink-soft);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.daymore {
		display: block;
		padding-top: 6px;
		font-size: 13px;
		font-weight: 700;
		color: var(--ink-soft);
	}
	.who {
		display: grid;
	}
	.who > :global(* + *) {
		border-top: 1px solid var(--line);
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
		gap: 22px 20px;
		/* Shopping's number at a tile's size (56 px at 1440). */
		--ramp-big: 3.5rem;
	}
	.tiles:not(:has(> :not(.hidden):not(.gone):not(:empty))) {
		display: none;
	}
	.tile {
		min-width: 0;
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
		grid-template-columns: 3rem minmax(0, 1fr) auto;
		align-items: center;
		gap: 10px;
		min-height: 40px;
		color: var(--ink);
		text-decoration: none;
	}
	.nextdays a.row:hover b {
		text-decoration: underline;
	}
	.nextdays .d {
		overflow: hidden;
		font-size: 13px;
		font-weight: 800;
		letter-spacing: 0.02em;
		text-overflow: ellipsis;
		text-transform: uppercase;
		white-space: nowrap;
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
		font-size: 13.5px;
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
		gap: 8px;
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
		min-height: 34px;
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
		text-decoration: none;
	}
	.meals a.meal:hover {
		text-decoration: underline;
	}

	/* ── Needs you ── */
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
	.foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 20px;
	}

	/* A display leaves out what does not fit its screen. */
	.gone {
		display: none !important;
	}
	.widgets {
		display: contents;
	}

	/* A display held upright (640 to 1023 px): the head beside the weather, the rest one column,
	   at the type of 1024 px. */
	@media (min-width: 640px) and (max-width: 1023.98px) {
		.wall.fm {
			--ramp-clock: 6rem;
			--ramp-date: 1.375rem;
			--ramp-countdown: 4.25rem;
			--ramp-hero: 2.25rem;
			--ramp-big: 4rem;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			grid-auto-flow: row dense;
			gap: 26px 32px;
		}
		.fm .col > * {
			grid-column: 1 / -1;
		}
		.fm .atm > .head,
		.fm .atm > .weather {
			grid-column: auto;
		}
	}

	/* From 1024 px: the clock and the weather share a band on top; the rest is one column. */
	@media (min-width: 1024px) and (max-width: 1279.98px) {
		.wall {
			--ramp-clock: 6.5rem;
			--ramp-date: 1.375rem;
			--ramp-big: 4.5rem;
			--ramp-hero: 2.5rem;
			/* The head's column has a width of its own: the clock is sized by it (a container). */
			grid-template-columns: minmax(16rem, 2fr) minmax(0, 3fr);
			gap: 26px 40px;
		}
		.col > * {
			grid-column: 1 / -1;
		}
		.atm > .head {
			grid-column: 1;
		}
		.atm > .weather {
			grid-column: 2;
		}
		.atm > .photo {
			max-width: 26rem;
		}
	}

	/* A display from 1024 px: always two columns, the left one narrower below 1280 px. When the
	   day's column runs out of room (`shift`), the tiles move to the atmosphere's column: the head
	   beside the next thing; under them "Who, next" on the right, and the weather, the tiles and
	   the photo on the left beside it. */
	@media (min-width: 1024px) {
		.wall.fm {
			grid-template-columns: 18rem minmax(0, 1fr);
			gap: 26px 36px;
			align-items: start;
		}
		.fm:not(.shift) .col {
			display: grid;
			grid-template-columns: minmax(0, 1fr);
			align-content: start;
			gap: 26px;
			min-width: 0;
		}
		.fm:not(.shift) .col > * {
			grid-column: auto;
			order: 0;
		}
		.fm:not(.shift) .atm {
			grid-column: 1;
		}
		.fm:not(.shift) .plan {
			grid-column: 2;
		}
		.fm.shift .col {
			display: contents;
		}
		.fm.shift .col > * {
			grid-column: 1 / -1;
			order: 0;
		}
		.fm.shift .atm > .head {
			grid-area: 1 / 1;
		}
		.fm.shift .plan > .hero {
			grid-area: 1 / 2;
		}
		.fm.shift .atm > .weather {
			grid-area: 2 / 1;
		}
		.fm.shift .plan > .tiles {
			grid-area: 3 / 1;
			grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
		}
		.fm.shift .atm > .photo {
			grid-area: 4 / 1;
		}
		.fm.shift .plan > .who-blk {
			grid-area: 2 / 2 / span 3;
		}
	}
	@media (min-width: 1280px) {
		.wall.fm {
			grid-template-columns: 25rem minmax(0, 1fr);
			gap: 26px 40px;
		}
	}

	/* What Today hides leaves no empty column: the head without the clock and the sentence is
	   only the phone's bell; the head or the weather alone takes the band's width; a column with
	   nothing to show gives its room to the other. */
	.bell {
		margin-inline-start: auto;
	}
	@media (min-width: 768px) {
		.head:not(:has(.time, .sentence, .status)) {
			display: none;
		}
	}
	@media (min-width: 1024px) and (max-width: 1279.98px) {
		.wall:not(.fm) .atm:not(:has(> .head :is(.time, .sentence, .status))) > .weather,
		.wall:not(.fm) .atm:not(:has(> .weather:not(:empty))) > .head {
			grid-column: 1 / -1;
		}
	}
	@media (min-width: 1280px) {
		.wall:not(
			:has(> .atm > .head :is(.time, .sentence, .status), > .atm > .blk:not(.search, .gone, :empty))
		),
		.wall:not(
			:has(
				> .plan > :not(.hidden, .gone, :empty, .tiles),
				> .plan > .tiles:not(.hidden, .gone) > :not(.hidden, .gone, :empty)
			)
		) {
			grid-template-columns: minmax(0, 1fr);
		}
		.wall:not(
				:has(
					> .atm > .head :is(.time, .sentence, .status),
					> .atm > .blk:not(.search, .gone, :empty)
				)
			)
			> .atm,
		.wall:not(
				:has(
					> .plan > :not(.hidden, .gone, :empty, .tiles),
					> .plan > .tiles:not(.hidden, .gone) > :not(.hidden, .gone, :empty)
				)
			)
			> .plan {
			display: none;
		}
		.wall:not(
				:has(
					> .atm > .head :is(.time, .sentence, .status),
					> .atm > .blk:not(.search, .gone, :empty)
				)
			)
			> .plan,
		.wall:not(
				:has(
					> .plan > :not(.hidden, .gone, :empty, .tiles),
					> .plan > .tiles:not(.hidden, .gone) > :not(.hidden, .gone, :empty)
				)
			)
			> .atm {
			grid-column: 1;
		}
	}

	/* From 1280 px: two columns, the atmosphere on the left (the design doc's 400 · 1fr). */
	@media (min-width: 1280px) {
		.wall {
			grid-template-columns: 25rem minmax(0, 1fr);
			gap: 40px;
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
			grid-column: 1;
		}
		.plan {
			grid-column: 2;
		}
		.search {
			display: block;
		}
	}
</style>
