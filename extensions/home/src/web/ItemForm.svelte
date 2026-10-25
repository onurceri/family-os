<script lang="ts">
	import { FieldError, type FieldErrors, fieldAria } from '@famos/ui/famos';
	import { Textarea } from '@famos/ui/textarea';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { ITEM_PRESETS } from '../contract/index.js';
	import type { ItemFormValue, PresetPicks } from './form.js';
	import { useHome } from './i18n.js';
	import PresetPicker from './PresetPicker.svelte';

	/**
	 * The form for a thing. A warranty end date makes a "Warranty ends" duty by itself; when
	 * adding, `picks` shows the usual upkeep (filter change, service).
	 */
	let {
		value = $bindable(),
		picks = $bindable(),
		errors = {},
		idPrefix = 'item',
	}: {
		value: ItemFormValue;
		picks?: PresetPicks;
		errors?: FieldErrors;
		idPrefix?: string;
	} = $props();
	const { app, t } = useHome();
	const id = (name: string) => `${idPrefix}-${name}`;
	const field =
		'border-line bg-wall text-ink focus-visible:border-info focus-visible:ring-info/25 h-[var(--ctl)] w-full rounded-[var(--r-ctl)] border px-3 text-[15px] outline-none focus-visible:ring-3';
</script>

{#snippet optional()}<span class="text-ink-soft font-normal">{t('optional')}</span>{/snippet}

<div class="@container grid gap-[18px]">
	<div class="grid gap-1.5">
		<Label for={id('name')}>{t('field_name')}</Label>
		<Input
			id={id('name')}
			bind:value={value.name}
			maxlength={80}
			required
			autocomplete="off"
			{...fieldAria(errors.name, id('name'))}
		/>
		<FieldError for={id('name')} error={errors.name} />
		<small class="text-ink-soft text-[13px]">{t('item_name_hint')}</small>
	</div>
	<div class="grid grid-cols-2 gap-x-3 gap-y-[18px]">
		<div class="grid gap-1.5">
			<Label for={id('room')}>{t('field_room')} {@render optional()}</Label>
			<Input id={id('room')} bind:value={value.room} maxlength={60} autocomplete="off" />
		</div>
		<div class="grid gap-1.5">
			<Label for={id('brand')}>{t('field_brand')} {@render optional()}</Label>
			<Input id={id('brand')} bind:value={value.brand} maxlength={60} autocomplete="off" />
		</div>
		<div class="grid gap-1.5">
			<Label for={id('model')}>{t('field_model')} {@render optional()}</Label>
			<Input id={id('model')} bind:value={value.model} maxlength={60} autocomplete="off" />
		</div>
		{#if app.can('home.edit')}
			<div class="grid gap-1.5">
				<Label for={id('serial')}>{t('field_serial')} {@render optional()}</Label>
				<Input id={id('serial')} bind:value={value.serial} maxlength={60} autocomplete="off" />
			</div>
		{/if}
		<div class="grid gap-1.5">
			<Label for={id('purchased')}>{t('field_purchased_on')} {@render optional()}</Label>
			<Input id={id('purchased')} type="date" bind:value={value.purchasedOn} />
		</div>
		<div class="col-span-2 grid gap-1.5">
			<Label for={id('warranty')}>{t('field_warranty_until')} {@render optional()}</Label>
			<Input
				id={id('warranty')}
				type="date"
				bind:value={value.warrantyUntil}
				{...fieldAria(errors.warrantyUntil, id('warranty'))}
				class="max-w-52"
			/>
			<FieldError for={id('warranty')} error={errors.warrantyUntil} />
			<small class="text-ink-soft text-[13px]">{t('field_warranty_hint')}</small>
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
	{#if picks}
		<PresetPicker presets={ITEM_PRESETS} bind:picks {errors} />
	{/if}
</div>
