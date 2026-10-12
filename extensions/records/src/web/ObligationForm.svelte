<script lang="ts">
	import { Textarea } from '@famos/ui/textarea';
	import { MemberChips } from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { useRecords } from './i18n.js';
	import type { ObligationFormValue } from './form.js';
	import { type RepeatUnit, withRepeat } from './repeat.js';

	/**
	 * The form of one obligation (it opens in the side panel or the phone sheet): what, when, how
	 * often, how early to be reminded, who.
	 */
	let {
		value = $bindable(),
		errors = {},
		idPrefix = 'obligation',
	}: {
		value: ObligationFormValue;
		errors?: Record<string, true>;
		idPrefix?: string;
	} = $props();

	const { app, t } = useRecords();
	const id = (name: string) => `${idPrefix}-${name}`;
	const flag = (path: string) => (errors[path] ? 'true' : undefined);
	const field =
		'border-line bg-wall text-ink focus-visible:border-info focus-visible:ring-info/25 h-[var(--ctl)] w-full rounded-[var(--r-ctl)] border px-3 text-[15px] outline-none focus-visible:ring-3';
</script>

<div class="@container grid gap-[18px]">
	<div class="grid gap-1.5">
		<Label for={id('title')}>{t('field_title')}</Label>
		<Input
			id={id('title')}
			bind:value={value.title}
			maxlength={160}
			required
			autocomplete="off"
			aria-invalid={flag('title')}
		/>
	</div>

	<div class="grid gap-[18px] @lg:grid-cols-2 @lg:gap-x-3">
		<div class="grid content-start gap-1.5">
			<Label for={id('due')}>{t('field_due_date')}</Label>
			<Input
				id={id('due')}
				type="date"
				bind:value={value.dueDate}
				required
				aria-invalid={flag('dueDate')}
			/>
		</div>

		<div class="grid content-start gap-1.5">
			<Label for={id('repeat')}>{t('field_repeat')}</Label>
			<select
				id={id('repeat')}
				value={value.repeat}
				onchange={(e) => (value = withRepeat(value, e.currentTarget.value as RepeatUnit))}
				class={field}
			>
				<option value="none">{t('repeat_none')}</option>
				<option value="months">{t('repeat_months')}</option>
				<option value="years">{t('repeat_years')}</option>
			</select>
		</div>
	</div>

	{#if value.repeat !== 'none'}
		<div class="flex items-center gap-2">
			<Label for={id('interval')} class="text-ink-soft text-sm font-normal"
				>{t('repeat_every')}</Label
			>
			<Input
				id={id('interval')}
				type="number"
				min={1}
				max={value.repeat === 'years' ? 50 : 120}
				bind:value={value.interval}
				class="w-24"
			/>
			<span class="text-ink-soft text-sm"
				>{value.repeat === 'years' ? t('unit_years') : t('unit_months')}</span
			>
		</div>
	{/if}

	<div class="grid gap-1.5">
		<Label for={id('lead')}>{t('field_lead_days')}</Label>
		<Input
			id={id('lead')}
			type="number"
			min={0}
			max={365}
			bind:value={value.leadDays}
			class="w-28"
		/>
		<small class="text-ink-soft text-[13px]">{t('field_lead_days_hint')}</small>
	</div>

	<fieldset class="grid gap-2">
		<legend class="mb-1.5 text-sm font-medium">{t('field_assignee')}</legend>
		<MemberChips members={app.members()} bind:selected={value.assignee} noneLabel={t('anyone')} />
	</fieldset>

	<div class="grid gap-1.5">
		<Label for={id('notes')}
			>{t('field_notes')}
			<span class="text-ink-soft font-normal">{t('optional')}</span></Label
		>
		<Textarea
			id={id('notes')}
			bind:value={value.notes}
			maxlength={2000}
			rows={2}
			class="{field} min-h-[84px] py-2"
		></Textarea>
	</div>
</div>
