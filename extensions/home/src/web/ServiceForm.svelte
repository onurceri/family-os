<script lang="ts">
	import { FieldError, type FieldErrors, fieldAria } from '@famos/ui/famos';
	import { Textarea } from '@famos/ui/textarea';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { SERVICE_KINDS } from '../contract/index.js';
	import type { ServiceFormValue } from './form.js';
	import { useHome } from './i18n.js';

	/** The form for a utility or subscription; the billing day is informational. */
	let {
		value = $bindable(),
		errors = {},
		idPrefix = 'service',
	}: { value: ServiceFormValue; errors?: FieldErrors; idPrefix?: string } = $props();
	const { t } = useHome();
	const id = (name: string) => `${idPrefix}-${name}`;
	const field =
		'border-line bg-wall text-ink focus-visible:border-info focus-visible:ring-info/25 h-[var(--ctl)] w-full rounded-[var(--r-ctl)] border px-3 text-[15px] outline-none focus-visible:ring-3';
</script>

{#snippet optional()}<span class="text-ink-soft font-normal">{t('optional')}</span>{/snippet}

<div class="@container grid gap-[18px]">
	<div class="grid grid-cols-2 gap-x-3 gap-y-[18px]">
		<div class="grid gap-1.5">
			<Label for={id('kind')}>{t('field_service_kind')}</Label>
			<select id={id('kind')} bind:value={value.kind} class={field}>
				{#each SERVICE_KINDS as kind (kind)}<option value={kind}>{t(`service_kind_${kind}`)}</option
					>{/each}
			</select>
		</div>
		<div class="grid gap-1.5">
			<Label for={id('provider')}>{t('field_provider')}</Label>
			<Input
				id={id('provider')}
				bind:value={value.provider}
				maxlength={80}
				required
				autocomplete="off"
				{...fieldAria(errors.provider, id('provider'))}
			/>
			<FieldError for={id('provider')} error={errors.provider} />
		</div>
		<div class="grid gap-1.5">
			<Label for={id('account')}>{t('field_account_number')} {@render optional()}</Label>
			<Input
				id={id('account')}
				bind:value={value.accountNumber}
				maxlength={60}
				autocomplete="off"
			/>
		</div>
		<div class="grid gap-1.5">
			<Label for={id('due-day')}>{t('field_due_day')} {@render optional()}</Label>
			<Input
				id={id('due-day')}
				bind:value={value.dueDay}
				inputmode="numeric"
				maxlength={2}
				autocomplete="off"
				{...fieldAria(errors.dueDay, id('due-day'))}
			/>
			<FieldError for={id('due-day')} error={errors.dueDay} />
			<small class="text-ink-soft text-[13px]">{t('field_due_day_hint')}</small>
		</div>
	</div>
	<div class="grid gap-1.5">
		<Label for={id('notes')}>{t('field_notes')} {@render optional()}</Label>
		<Textarea
			id={id('notes')}
			bind:value={value.notes}
			maxlength={2000}
			rows={2}
			class="{field} min-h-[84px] py-2"
		></Textarea>
	</div>
</div>
