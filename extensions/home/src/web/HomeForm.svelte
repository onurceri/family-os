<script lang="ts">
	import { Textarea } from '@famos/ui/textarea';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { HOME_PRESETS, TENURES } from '../contract/index.js';
	import type { HomeFormValue, PresetPicks } from './form.js';
	import { useHome } from './i18n.js';
	import PresetPicker from './PresetPicker.svelte';

	/** The home form; when adding, `picks` shows "what usually needs doing". */
	let {
		value = $bindable(),
		picks = $bindable(),
		errors = {},
		idPrefix = 'home',
	}: {
		value: HomeFormValue;
		picks?: PresetPicks;
		errors?: Record<string, true>;
		idPrefix?: string;
	} = $props();
	const { t } = useHome();
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
			aria-invalid={errors.name ? 'true' : undefined}
		/>
		<small class="text-ink-soft text-[13px]">{t('home_name_hint')}</small>
	</div>
	<div class="grid gap-1.5">
		<Label for={id('address')}>{t('field_address')} {@render optional()}</Label>
		<Textarea
			id={id('address')}
			bind:value={value.address}
			maxlength={300}
			rows={2}
			class="{field} min-h-[84px] py-2"
		></Textarea>
	</div>
	<div class="grid gap-1.5">
		<Label for={id('tenure')}>{t('field_tenure')}</Label>
		<select id={id('tenure')} bind:value={value.tenure} class={field}>
			{#each TENURES as tenure (tenure)}<option value={tenure}>{t(`tenure_${tenure}`)}</option
				>{/each}
		</select>
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
		<PresetPicker presets={HOME_PRESETS} bind:picks {errors} />
	{/if}
</div>
