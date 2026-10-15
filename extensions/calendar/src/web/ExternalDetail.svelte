<script lang="ts">
	import { Button } from '@famos/ui/button';
	import type { Occurrence } from '../contract/index.js';
	import { describeWhen, timeLabel } from './format.js';
	import { useCalendar } from './i18n.js';

	/** A subscription's event, read-only: what, when, where, notes and where it comes from. */
	let {
		occurrence,
		onclose,
		bare = false,
	}: {
		occurrence: Occurrence;
		onclose: () => void;
		/** Without its own card: inside the side panel. */
		bare?: boolean;
	} = $props();
	const { app, t } = useCalendar();

	const when = $derived.by(() => {
		if (occurrence.allDay) {
			return describeWhen(
				{
					allDay: true,
					date: occurrence.startDate as string,
					endDate: occurrence.endDate,
				},
				app.dateLocale(),
				t('all_day'),
			);
		}
		const zone = app.timeZone();
		const start = occurrence.start as number;
		const end = occurrence.end as number;
		const date = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(start);
		return describeWhen(
			{
				date,
				startTime: timeLabel(start, zone, app.dateLocale(), app.hourCycle()),
				endTime: end > start ? timeLabel(end, zone, app.dateLocale(), app.hourCycle()) : null,
			},
			app.dateLocale(),
			t('all_day'),
			app.hourCycle(),
		);
	});
	const members = $derived(app.members().filter((m) => occurrence.memberIds.includes(m.id)));
</script>

<section class="grid scroll-mt-4 gap-4 {bare ? '' : 'bg-surface shadow-lit rounded-xl p-4 sm:p-5'}">
	<div class="grid gap-1">
		{#if !bare}<h2 class="text-lg font-extrabold break-words">{occurrence.title}</h2>{/if}
		{#if occurrence.source}
			<p class="flex items-center gap-2 text-sm font-semibold">
				<span
					class="size-2.5 shrink-0 rounded-full"
					style:background-color={occurrence.source.color}
					aria-hidden="true"
				></span>
				{t('from_calendar', { name: occurrence.source.name })}
			</p>
		{/if}
	</div>
	<dl class="grid gap-3 text-sm">
		<div class="grid gap-0.5">
			<dt class="text-ink-soft text-xs font-semibold tracking-widest uppercase">{t('when')}</dt>
			<dd>{when}</dd>
		</div>
		{#if occurrence.location}
			<div class="grid gap-0.5">
				<dt class="text-ink-soft text-xs font-semibold tracking-widest uppercase">{t('where')}</dt>
				<dd class="break-words">{occurrence.location}</dd>
			</div>
		{/if}
		{#if members.length}
			<div class="grid gap-0.5">
				<dt class="text-ink-soft text-xs font-semibold tracking-widest uppercase">{t('who')}</dt>
				<dd>{members.map((m) => m.displayName).join(', ')}</dd>
			</div>
		{/if}
		{#if occurrence.notes}
			<div class="grid gap-0.5">
				<dt class="text-ink-soft text-xs font-semibold tracking-widest uppercase">{t('notes')}</dt>
				<dd class="break-words whitespace-pre-line">{occurrence.notes}</dd>
			</div>
		{/if}
	</dl>
	<p class="text-ink-soft text-sm">{t('read_only_hint')}</p>
	<div>
		<Button type="button" size="lg" variant="ghost" onclick={onclose}>{t('close')}</Button>
	</div>
</section>
