<script lang="ts">
	import { useApp } from '../app-context.js';
	import type { TimelineItem } from '../slots.js';
	import Avatar from './Avatar.svelte';
	import { groupOf, hasEnded, type TimelineLabels, viewTimeline } from './timeline.js';

	/**
	 * A day as a line: all-day items, then timed ones with the now-line between past and future,
	 * the next item lifted into the one lit card (today: outlined in `accent`), past
	 * items faded. Used by the phone calendar's agenda. Generic: it knows items, `now` and the
	 * app's members and time formats.
	 */
	let {
		items,
		now,
		showNow = true,
		labels,
		empty,
	}: {
		items: readonly TimelineItem[];
		now: number;
		/** False for another day than today: no now-line, nothing faded, "first" instead of "in…". */
		showNow?: boolean;
		labels: TimelineLabels;
		/** Shown when there are no items. */
		empty?: string;
	} = $props();

	const app = useApp();
	const view = $derived(viewTimeline(items, showNow ? now : Number.NEGATIVE_INFINITY));
	const members = $derived(new Map(app.members().map((m) => [m.id, m])));

	function clock(at: number): string {
		return new Intl.DateTimeFormat(app.dateLocale(), {
			hour: app.hourCycle() === 'h12' ? 'numeric' : '2-digit',
			minute: '2-digit',
			timeZone: app.timeZone(),
			hourCycle: app.hourCycle(),
		}).format(at);
	}
	const colorOf = (item: TimelineItem) =>
		(item.members?.[0] ? members.get(item.members[0])?.color : undefined) ?? undefined;
	const people = (item: TimelineItem) =>
		(item.members ?? []).map((id) => members.get(id)).filter((m) => m !== undefined);
	const minutesTo = (item: TimelineItem) =>
		Math.max(1, Math.round(((item.start ?? now) - now) / 60_000));
	// The first row of each group names the group in the time column.
	function groupLabel(i: number): string {
		const item = view.items[i];
		if (!item) return '';
		const g = groupOf(item);
		const before = i > 0 ? view.items[i - 1] : undefined;
		if (g === 1 || (before && groupOf(before) === g)) return '';
		return g === 0 ? labels.allDay : g === 2 ? labels.anytime : labels.evening;
	}
	const nowTime = $derived(clock(now));
</script>

{#snippet nowLine()}
	<li
		class="relative z-10 grid h-5 grid-cols-[76px_22px_minmax(0,1fr)] items-center px-3"
		aria-hidden="true"
	>
		<span class="text-now text-[13px] font-extrabold tabular-nums">{nowTime}</span>
		<span class="relative flex items-center justify-center self-stretch">
			<span class="bg-line absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2"></span>
			<span class="bg-now ring-wall relative size-2.5 rounded-full ring-2"></span>
		</span>
		<span class="bg-now ml-3 h-0.5 rounded-full"></span>
	</li>
{/snippet}

{#if view.items.length === 0}
	{#if empty}<p class="text-ink-soft py-2 text-sm">{empty}</p>{/if}
{:else}
	<ol class="grid" data-testid="timeline">
		{#each view.items as item, i (item.id)}
			{#if showNow && i === view.nowIndex}{@render nowLine()}{/if}
			{@const lit = item.id === view.nextId}
			{@const past = showNow && (hasEnded(item, now) || (item.done ?? false))}
			{@const timed = groupOf(item) === 1 && item.start !== undefined && !item.nominal}
			{@const who = people(item)}
			{@const color = colorOf(item)}
			{@const time = timed ? clock(item.start as number) : ''}
			<li class={past ? 'opacity-55' : ''}>
				<!-- A button when the row has `onselect`, a link otherwise. -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<svelte:element
					this={item.onselect ? 'button' : 'a'}
					href={item.onselect ? undefined : item.href}
					type={item.onselect ? 'button' : undefined}
					onclick={item.onselect}
					aria-current={lit ? 'step' : undefined}
					style:outline={lit && showNow ? '2px solid var(--accent)' : undefined}
					style:outline-offset={lit && showNow ? '-2px' : undefined}
					aria-label={lit
						? `${item.title}, ${time}, ${showNow ? labels.until(minutesTo(item)) : labels.first}`
						: undefined}
					class="focus-visible:ring-ring grid w-full grid-cols-[76px_22px_minmax(0,1fr)] items-center px-3 text-start focus-visible:ring-2 focus-visible:outline-none {lit
						? 'bg-surface shadow-lit min-h-16 rounded-[14px]'
						: 'min-h-12 rounded-lg'}"
				>
					<span
						class="text-ink-soft self-center text-[13px] leading-tight font-semibold whitespace-nowrap tabular-nums {timed
							? 'text-[15px]'
							: ''} {lit ? 'text-ink' : ''}"
					>
						{#if timed}{time}{:else}<span class="text-[11px] font-bold tracking-wide uppercase"
								>{groupLabel(i)}</span
							>{/if}
					</span>
					<span class="relative flex items-center justify-center self-stretch">
						<span class="bg-line absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2"></span>
						{#if item.kind === 'meal'}
							<span
								class="bg-heat text-on-color relative grid size-6 place-items-center rounded-md"
								aria-hidden="true"
								><svg
									class="size-3.5"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
									><path d="m16 2-2.3 2.3a3 3 0 0 0 0 4.2l1.8 1.8a3 3 0 0 0 4.2 0L22 8Z" /><path
										d="M15 15 3.3 3.3a4.2 4.2 0 0 0 0 6l7.3 7.3c.7.7 2 .7 2.8 0L15 15Zm0 0 7 7"
									/><path d="m2.1 21.8 6.4-6.3" /><path d="m19 5-7 7" /></svg
								></span
							>
						{:else if item.kind === 'chore' || item.kind === 'task'}
							<span
								class="bg-wall relative grid size-4 place-items-center rounded-[5px] border-2 {item.done
									? 'bg-now text-on-color border-transparent'
									: 'border-ink-soft/55 text-transparent'}"
								aria-hidden="true"
								><svg
									class="size-3"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="3.5"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg
								></span
							>
						{:else}
							<span
								class="relative size-2.5 {groupOf(item) === 0
									? 'rounded-[3px]'
									: 'rounded-full'} {color ? '' : 'bg-ink-soft'}"
								style:background-color={color}
								aria-hidden="true"
							></span>
						{/if}
					</span>
					<span class="flex min-w-0 items-center gap-3 py-1.5 pl-3">
						<span class="grid min-w-0 flex-1 gap-0.5">
							<span
								class="truncate leading-snug {lit
									? 'text-[17px] font-extrabold'
									: 'text-[15px] font-bold'} {item.done ? 'line-through' : ''}">{item.title}</span
							>
							{#if item.subtitle}
								<span class="text-ink-soft truncate text-[13px] leading-snug">{item.subtitle}</span>
							{/if}
						</span>
						{#if lit}
							<span class="text-now shrink-0 self-start pt-2 text-[13px] font-extrabold"
								>{showNow ? labels.until(minutesTo(item)) : labels.first}</span
							>
						{:else if who.length > 1}
							<span class="flex shrink-0 -space-x-1.5" aria-hidden="true">
								{#each who.slice(0, 3) as m (m.id)}
									<span class="ring-wall rounded-full ring-2"
										><Avatar name={m.displayName} color={m.color} size={22} /></span
									>
								{/each}
							</span>
						{/if}
					</span>
				</svelte:element>
			</li>
		{/each}
		{#if showNow && view.nowIndex >= view.items.length}{@render nowLine()}{/if}
	</ol>
{/if}
