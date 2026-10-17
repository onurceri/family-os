<script lang="ts">
	import { Textarea } from '@famos/ui/textarea';
	import { orderedWeekdays, weekdayNames } from '@famos/time';
	import {
		fieldAria,
		FieldError,
		type FieldErrors,
		MemberChips,
		RepeatPicker,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { onMount } from 'svelte';
	import { endsNextDay, type Tag } from '../contract/index.js';
	import { loadTags } from './data.js';
	import {
		type EventFormValue,
		reminderFor,
		reminderKey,
		reminderOptions,
		shiftEnd,
	} from './form.js';
	import { useCalendar } from './i18n.js';
	import TagInput from './TagInput.svelte';

	/**
	 * The event form, shared by the calendar page and the Inbox draft editor. `value` is bound;
	 * `errors` marks fields (by input path) and `uncertain` marks fields the AI was unsure of.
	 */
	let {
		value = $bindable(),
		errors = {},
		uncertain = [],
		idPrefix = 'event',
	}: {
		value: EventFormValue;
		errors?: FieldErrors;
		uncertain?: readonly string[];
		idPrefix?: string;
	} = $props();

	const { app, t } = useCalendar();
	const days = $derived.by(() => {
		const names = weekdayNames(app.dateLocale());
		return orderedWeekdays(app.weekStart()).map((code) => ({ code, label: names[code] }));
	});
	const repeatLabels = $derived({
		none: t('repeat_none'),
		daily: t('repeat_daily'),
		weekly: t('repeat_weekly'),
		monthly: t('repeat_monthly'),
		custom: t('repeat_custom'),
		until: t('field_until'),
	});
	// The family's tags: suggestions and colours. The form still works without them.
	let knownTags = $state<Tag[]>([]);
	onMount(async () => {
		try {
			knownTags = await loadTags();
		} catch {
			knownTags = [];
		}
	});

	const id = (name: string) => `${idPrefix}-${name}`;
	const unsure = (path: string) => uncertain.includes(path);

	const reminderLabel = (minutes: number) => t(reminderKey(value.allDay, minutes));

	function setStart(event: Event) {
		const next = (event.currentTarget as HTMLInputElement).value;
		value.endTime = shiftEnd(value.startTime, next, value.endTime);
		value.startTime = next;
	}
</script>

{#snippet check(path: string)}
	{#if unsure(path)}<span
			class="bg-attention/15 text-ink ml-2 rounded-full px-2 py-0.5 text-[0.7rem] font-bold normal-case"
			>{app.t('app:draft_check_this')}</span
		>{/if}
{/snippet}

<!-- Fields pair up from about 40rem of room, wherever the form sits. -->
<div class="@container">
	<div class="grid gap-5">
		<div class="grid gap-1.5">
			<Label for={id('title')}>{t('field_title')}{@render check('title')}</Label>
			<Input
				id={id('title')}
				bind:value={value.title}
				maxlength={120}
				required
				{...fieldAria(errors.title, id('title'))}
				autocomplete="off"
			/>
			<FieldError for={id('title')} error={errors.title} />
		</div>

		<div class="grid gap-3">
			<label class="flex min-h-11 items-center gap-3 font-semibold">
				<input
					type="checkbox"
					bind:checked={value.allDay}
					onchange={() => (value.reminder = reminderFor(value.allDay, value.reminder))}
					class="accent-ink size-5"
				/>
				{t('field_all_day')}{@render check('allDay')}
			</label>
			<div class="grid grid-cols-2 gap-3">
				<div class="grid gap-1.5 {value.allDay ? '' : 'col-span-2'}">
					<Label for={id('date')}>{t('field_date')}{@render check('date')}</Label>
					<Input
						id={id('date')}
						type="date"
						bind:value={value.date}
						required
						{...fieldAria(errors.date, id('date'))}
					/>
					<FieldError for={id('date')} error={errors.date} />
				</div>
				{#if value.allDay}
					<div class="grid gap-1.5">
						<Label for={id('end-date')}>{t('field_end_date')}{@render check('endDate')}</Label>
						<Input
							id={id('end-date')}
							type="date"
							bind:value={value.endDate}
							min={value.date}
							{...fieldAria(errors.endDate, id('end-date'))}
						/>
						<FieldError for={id('end-date')} error={errors.endDate} />
					</div>
				{:else}
					<div class="grid gap-1.5">
						<Label for={id('start')}>{t('field_start')}{@render check('startTime')}</Label>
						<Input
							id={id('start')}
							type="time"
							value={value.startTime}
							onchange={setStart}
							required
							{...fieldAria(errors.startTime, id('start'))}
						/>
						<FieldError for={id('start')} error={errors.startTime} />
					</div>
					<div class="grid gap-1.5">
						<Label for={id('end')}>{t('field_end')}{@render check('endTime')}</Label>
						<Input
							id={id('end')}
							type="time"
							bind:value={value.endTime}
							{...fieldAria(errors.endTime, id('end'))}
						/>
						<FieldError for={id('end')} error={errors.endTime} />
						{#if endsNextDay(value.startTime, value.endTime)}
							<small class="text-ink-soft text-xs">{t('ends_next_day')}</small>
						{/if}
					</div>
				{/if}
			</div>
		</div>

		<fieldset class="grid gap-2">
			<legend class="mb-1.5 text-sm font-medium"
				>{t('field_members')}{@render check('memberIds')}</legend
			>
			<MemberChips
				members={app.members()}
				bind:selected={value.memberIds}
				multiple
				noneLabel={t('everyone')}
			/>
		</fieldset>

		<fieldset class="grid gap-2">
			<legend class="mb-1.5 text-sm font-medium"
				>{t('field_repeat')}{@render check('recurrence')}</legend
			>
			<RepeatPicker
				bind:preset={value.repeat}
				bind:byDay={value.byDay}
				bind:until={value.until}
				{days}
				labels={repeatLabels}
				min={value.date}
				{idPrefix}
				error={errors.recurrence}
				untilError={errors.until}
			/>
		</fieldset>

		<div class="grid gap-5 @2xl:grid-cols-2 @2xl:gap-x-3">
			<div class="grid gap-1.5">
				<Label for={id('reminder')}>{t('field_reminder')}{@render check('reminder')}</Label>
				<select
					id={id('reminder')}
					bind:value={value.reminder}
					{...fieldAria(errors.reminder, id('reminder'))}
					class="border-input h-9 w-full rounded-md border bg-transparent px-2 text-base md:text-sm"
				>
					<option value="none">{t('reminder_none')}</option>
					{#each reminderOptions(value.allDay) as minutes (minutes)}
						<option value={String(minutes)}>{reminderLabel(minutes)}</option>
					{/each}
				</select>
				<FieldError for={id('reminder')} error={errors.reminder} />
			</div>

			<div class="grid gap-1.5">
				<Label for={id('tags')}>{t('field_tags')}{@render check('tags')}</Label>
				<TagInput id={id('tags')} bind:value={value.tags} known={knownTags} />
			</div>
		</div>

		<div class="grid gap-1.5">
			<Label for={id('location')}>{t('field_location')}{@render check('location')}</Label>
			<Input id={id('location')} bind:value={value.location} maxlength={200} autocomplete="off" />
		</div>

		<div class="grid gap-1.5">
			<Label for={id('notes')}>{t('field_notes')}{@render check('notes')}</Label>
			<Textarea
				id={id('notes')}
				bind:value={value.notes}
				maxlength={2000}
				rows={3}
				class="border-input focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-2.5 py-2 text-base outline-none focus-visible:ring-3 md:text-sm"
			></Textarea>
		</div>
	</div>
</div>
