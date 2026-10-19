<script lang="ts">
	import { describeRecurrence } from '@famos/time';
	import { Button } from '@famos/ui/button';
	import {
		AwaitingMark,
		awaitingRowText,
		ConfirmButton,
		editLabel,
		removeLabels,
	} from '@famos/ui/famos';
	import type { EventDetail, Occurrence, Tag } from '../contract/index.js';
	import { describeWhen } from './format.js';
	import { reminderKey } from './form.js';
	import { useCalendar } from './i18n.js';
	import TagChip from './TagChip.svelte';
	import { colorOf } from './tags.js';
	import { isWaiting } from './waiting.js';

	/** A family event's details in the side panel: when, who, where, reminder, tags, notes. */
	let {
		occurrence,
		event,
		tags,
		onedit,
		ondelete,
		mayEdit,
		mayDelete,
	}: {
		occurrence: Occurrence;
		event: EventDetail;
		tags: readonly Tag[];
		onedit: () => void;
		ondelete: (onlyThis: boolean) => void;
		/** What the viewer may do with it; a control they may not use is not drawn. */
		mayEdit: boolean;
		mayDelete: boolean;
	} = $props();
	const { app, t } = useCalendar();
	// Whose event it is can decide whether removing it waits for approval.
	const removal = (label: string, confirmLabel: string) =>
		removeLabels(app, 'calendar.deleteEvent', { label, confirmLabel }, { id: occurrence.eventId });

	const members = $derived(app.members().filter((m) => event.memberIds.includes(m.id)));
	// The occurrence's own day: a repeating event's detail holds only the first one.
	const date = $derived(
		occurrence.allDay
			? (occurrence.startDate as string)
			: new Intl.DateTimeFormat('en-CA', { timeZone: app.timeZone() }).format(
					occurrence.start as number,
				),
	);
	const when = $derived.by(() => {
		return describeWhen(
			{
				allDay: event.allDay,
				date,
				endDate: occurrence.allDay ? occurrence.endDate : null,
				startTime: event.startTime,
				endTime: event.endTime,
			},
			app.dateLocale(),
			t('all_day'),
			app.hourCycle(),
		);
	});
	const repeats = $derived(
		event.recurrence
			? describeRecurrence(
					event.recurrence as Parameters<typeof describeRecurrence>[0],
					(key: string, options?: Record<string, unknown>) => app.t(`calendar:${key}`, options),
					app.dateLocale(),
					app.weekStart(),
					date,
				)
			: null,
	);
	const rows = $derived([
		{ label: t('when'), value: repeats ? `${when} · ${repeats}` : when },
		{
			label: t('who'),
			value: members.length ? members.map((m) => m.displayName).join(', ') : t('everyone'),
		},
		...(event.location ? [{ label: t('where'), value: event.location }] : []),
		{
			label: t('reminder'),
			value:
				event.reminder === null ? t('reminder_none') : t(reminderKey(event.allDay, event.reminder)),
		},
	]);
</script>

<div class="grid gap-5">
	{#if isWaiting(occurrence)}
		<!-- A new event nobody has approved yet: read-only, decided in Quick add. -->
		<p class="text-ink-soft text-xs font-semibold" data-testid="approval-mark">
			{awaitingRowText(app, occurrence.waiting).meta}
		</p>
	{:else}
		<AwaitingMark id={event.id} />
	{/if}
	<dl class="grid gap-3 text-sm">
		{#each rows as row (row.label)}
			<div class="grid gap-0.5">
				<dt class="text-ink-soft text-xs font-semibold tracking-widest uppercase">{row.label}</dt>
				<dd class="break-words">{row.value}</dd>
			</div>
		{/each}
		{#if event.tags.length}
			<div class="grid gap-1">
				<dt class="text-ink-soft text-xs font-semibold tracking-widest uppercase">{t('tags')}</dt>
				<dd class="flex flex-wrap gap-x-3 gap-y-1">
					{#each event.tags as name (name)}<TagChip {name} color={colorOf(tags, name)} />{/each}
				</dd>
			</div>
		{/if}
		{#if event.notes}
			<div class="grid gap-0.5">
				<dt class="text-ink-soft text-xs font-semibold tracking-widest uppercase">{t('notes')}</dt>
				<dd class="max-w-prose break-words whitespace-pre-line">{event.notes}</dd>
			</div>
		{/if}
	</dl>
	{#if mayEdit || mayDelete}
		<div class="flex flex-wrap items-center gap-2">
			{#if mayEdit}<Button type="button" size="lg" onclick={onedit}
					>{editLabel(app, 'calendar.updateEvent', t('edit_event'))}</Button
				>{/if}
			{#if mayDelete}
				<span class="ms-auto flex flex-wrap gap-1">
					{#if occurrence.recurring}
						<ConfirmButton
							{...removal(t('delete_one'), t('delete_one_confirm'))}
							onconfirm={() => ondelete(true)}
						/>
						<ConfirmButton
							{...removal(t('delete_series'), t('delete_series_confirm'))}
							onconfirm={() => ondelete(false)}
						/>
					{:else}
						<ConfirmButton
							{...removal(t('delete'), t('delete_confirm'))}
							onconfirm={() => ondelete(false)}
						/>
					{/if}
				</span>
			{/if}
		</div>
	{/if}
</div>
