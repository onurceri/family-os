<script lang="ts">
	import { Textarea } from '@famos/ui/textarea';
	import { orderedWeekdays, weekdayNames } from '@famos/time';
	import { Chip, LimitCounter, MemberChips, Segmented } from '@famos/ui/famos';
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
		idPrefix = 'task',
	}: {
		value: TaskFormValue;
		errors?: Record<string, true>;
		uncertain?: readonly string[];
		idPrefix?: string;
	} = $props();

	const { app, t } = useLists();
	const days = $derived.by(() => {
		const names = weekdayNames(app.formatLocale());
		return orderedWeekdays(app.weekStart()).map((code) => ({ code, label: names[code] }));
	});
	// A rule outside the presets (a custom RRULE) is shown but cannot be picked.
	const repeatOptions = $derived([
		{ value: 'none', label: t('repeat_short_none') },
		{ value: 'daily', label: t('repeat_short_daily') },
		{ value: 'weekly', label: t('repeat_short_weekly') },
		{ value: 'monthly', label: t('repeat_short_monthly') },
		...(value.repeat === 'custom'
			? [{ value: 'custom', label: t('repeat_custom'), disabled: true }]
			: []),
	]);
	function toggleDay(code: string) {
		const next = value.byDay.includes(code)
			? value.byDay.filter((d) => d !== code)
			: [...value.byDay, code];
		value.byDay = days.map((d) => d.code).filter((c) => next.includes(c));
	}
	const id = (name: string) => `${idPrefix}-${name}`;
	const flag = (path: string) => (errors[path] ? 'true' : undefined);
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
			aria-invalid={flag('title')}
			aria-describedby={id('title-limit')}
			autocomplete="off"
		/>
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
				aria-invalid={flag('dueDate')}
			/>
		</div>
		<div class="grid gap-1.5">
			<Label for={id('due-time')}>{t('field_due_time')}{@render check('dueTime')}</Label>
			<Input
				id={id('due-time')}
				type="time"
				bind:value={value.dueTime}
				disabled={!value.dueDate}
				aria-invalid={flag('dueTime')}
			/>
		</div>
	</div>

	<fieldset class="grid gap-2">
		<legend class="mb-1.5 text-sm font-medium"
			>{t('field_repeat')}{@render check('recurrence')}</legend
		>
		<Segmented
			grow
			label={t('field_repeat')}
			options={repeatOptions}
			value={value.repeat}
			onchange={(v) => (value.repeat = v as TaskFormValue['repeat'])}
		/>
		{#if value.repeat === 'weekly'}
			<div class="flex flex-wrap gap-1.5" role="group" aria-label={t('repeat_weekly')}>
				{#each days as day (day.code)}
					<Chip on={value.byDay.includes(day.code)} onclick={() => toggleDay(day.code)}
						>{day.label}</Chip
					>
				{/each}
			</div>
		{/if}
		{#if value.repeat !== 'none' && value.repeat !== 'custom'}
			<div class="grid max-w-56 gap-1.5">
				<Label for={id('until')}>{t('field_until')}</Label>
				<Input
					id={id('until')}
					type="date"
					bind:value={value.until}
					min={value.dueDate || undefined}
					aria-invalid={errors.until ? 'true' : undefined}
				/>
			</div>
		{/if}
		{#if value.repeat !== 'none' && !value.dueDate}
			<small class="text-[13px] {errors.dueDate ? 'text-attention font-semibold' : 'text-ink-soft'}"
				>{t('repeat_hint')}</small
			>
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
