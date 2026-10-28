<script lang="ts">
	import { Textarea } from '@famos/ui/textarea';
	import { orderedWeekdays, weekdayNames } from '@famos/time';
	import {
		fieldAria,
		FieldError,
		type FieldErrors,
		fieldErrorId,
		LimitCounter,
		MemberChips,
		RepeatPicker,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { TASK_TITLE_MAX } from '../contract/index.js';
	import { useLists } from './i18n.js';
	import type { TaskFormValue } from './task-form.js';

	/**
	 * The task form, shared by the Lists page and the Inbox draft editor. `errors` marks fields by
	 * input path; `uncertain` marks fields the AI was unsure of.
	 */
	let {
		value = $bindable(),
		errors = {},
		uncertain = [],
		saved = false,
		idPrefix = 'task',
	}: {
		value: TaskFormValue;
		errors?: FieldErrors;
		uncertain?: readonly string[];
		/** The item is already saved: moving its date leaves its repeat days as they are. */
		saved?: boolean;
		idPrefix?: string;
	} = $props();

	const { app, t } = useLists();
	const days = $derived.by(() => {
		const names = weekdayNames(app.dateLocale());
		return orderedWeekdays(app.weekStart()).map((code) => ({ code, label: names[code] }));
	});
	const repeatLabels = $derived({
		none: t('repeat_short_none'),
		daily: t('repeat_short_daily'),
		weekly: t('repeat_short_weekly'),
		monthly: t('repeat_short_monthly'),
		custom: t('repeat_custom'),
		until: t('field_until'),
		firstTime: (date: string) => t('repeat_next', { date }),
	});
	const id = (name: string) => `${idPrefix}-${name}`;
</script>

{#snippet check(path: string)}
	{#if uncertain.includes(path)}<span
			class="bg-attention/15 text-ink ml-2 rounded-full px-2 py-0.5 text-[0.7rem] font-bold normal-case"
			>{app.t('app:draft_check_this')}</span
		>{/if}
{/snippet}

<div class="grid gap-5">
	<div class="grid gap-1.5">
		<Label for={id('title')}>{t('field_title')}{@render check('title')}</Label>
		<Input
			id={id('title')}
			bind:value={value.title}
			required
			aria-invalid={errors.title ? 'true' : undefined}
			aria-describedby={[errors.title && fieldErrorId(id('title')), id('title-limit')]
				.filter(Boolean)
				.join(' ')}
			autocomplete="off"
		/>
		<FieldError for={id('title')} error={errors.title} />
		<LimitCounter
			id={id('title-limit')}
			text={value.title}
			max={TASK_TITLE_MAX}
			tooLong={(counter) => t('too_long', { counter })}
		/>
	</div>

	<fieldset class="grid gap-2">
		<legend class="mb-1.5 text-sm font-medium"
			>{t('field_assignee')}{@render check('assigneeId')}</legend
		>
		<MemberChips members={app.members()} bind:selected={value.assignee} noneLabel={t('anyone')} />
	</fieldset>

	<div class="grid grid-cols-2 gap-3">
		<div class="grid gap-1.5">
			<Label for={id('due-date')}>{t('field_due_date')}{@render check('dueDate')}</Label>
			<Input
				id={id('due-date')}
				type="date"
				bind:value={value.dueDate}
				{...fieldAria(errors.dueDate, id('due-date'))}
			/>
			<FieldError for={id('due-date')} error={errors.dueDate} />
		</div>
		<div class="grid gap-1.5">
			<Label for={id('due-time')}>{t('field_due_time')}{@render check('dueTime')}</Label>
			<Input
				id={id('due-time')}
				type="time"
				bind:value={value.dueTime}
				disabled={!value.dueDate}
				{...fieldAria(errors.dueTime, id('due-time'))}
			/>
			<FieldError for={id('due-time')} error={errors.dueTime} />
		</div>
	</div>

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
			min={value.dueDate || undefined}
			startDate={value.dueDate}
			{saved}
			dateLocale={app.dateLocale()}
			{idPrefix}
			error={errors.recurrence}
			untilError={errors.until}
		/>
		{#if value.repeat !== 'none' && !value.dueDate}
			<small class="text-ink-soft text-[13px]">{t('repeat_hint')}</small>
		{/if}
	</fieldset>

	<div class="grid gap-1.5">
		<Label for={id('notes')}
			>{t('field_notes')}
			<span class="text-ink-soft font-normal">{t('optional')}</span>{@render check('notes')}</Label
		>
		<Textarea
			id={id('notes')}
			bind:value={value.notes}
			maxlength={2000}
			rows={3}
			class="border-input focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-2.5 py-2 text-base outline-none focus-visible:ring-3 md:text-sm"
		></Textarea>
	</div>
</div>
