<script lang="ts">
	import { Card, ScheduleFields } from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import type { ObligationPreset } from '@famos/ext-records/contract';
	import type { PresetPicks } from './form.js';
	import { useHome } from './i18n.js';

	/**
	 * "What usually needs doing" in an add form, a checklist: tick a duty and give its first due date. The
	 * repeat and lead time start from the preset's suggestion and are the person's to change.
	 */
	let {
		presets,
		picks = $bindable(),
		errors = {},
	}: {
		presets: readonly ObligationPreset[];
		picks: PresetPicks;
		errors?: Record<string, true>;
	} = $props();
	const { app, t } = useHome();
	const labels = $derived({
		repeat: app.t('records:field_repeat'),
		none: app.t('records:repeat_none'),
		months: app.t('records:repeat_months'),
		years: app.t('records:repeat_years'),
		every: app.t('records:repeat_every'),
		unitMonths: app.t('records:unit_months'),
		unitYears: app.t('records:unit_years'),
		leadDays: app.t('records:field_lead_days'),
	});
</script>

<fieldset class="grid gap-2">
	<legend class="mb-1 text-sm font-medium">
		{t('presets_title')} <span class="text-ink-soft font-normal">{t('presets_hint')}</span>
	</legend>
	<Card rows>
		{#each presets as preset (preset.id)}
			{@const pick = picks[preset.id]}
			{#if pick}
				<div class="grid gap-2.5 px-3 py-2.5">
					<label class="flex min-h-9 items-start gap-3">
						<input
							type="checkbox"
							bind:checked={pick.on}
							class="accent-ink mt-0.5 size-5 shrink-0"
							data-testid="preset-{preset.id}"
						/>
						<span class="grid gap-0.5">
							<b class="text-[15px]">{app.t(preset.titleKey)}</b>
							{#if preset.labelKey}
								<small class="text-ink-soft text-[13px] font-normal">{app.t(preset.labelKey)}</small
								>
							{/if}
						</span>
					</label>
					{#if pick.on}
						<div class="grid gap-2.5 ps-8">
							<Input
								type="date"
								bind:value={pick.date}
								required
								aria-label={t('preset_due', { title: app.t(preset.titleKey) })}
								aria-invalid={errors[`preset_${preset.id}`] ? 'true' : undefined}
								class="max-w-56"
							/>
							<ScheduleFields
								bind:repeat={pick.repeat}
								bind:interval={pick.interval}
								bind:leadDays={pick.leadDays}
								{labels}
								idPrefix="preset-{preset.id}"
							/>
						</div>
					{/if}
				</div>
			{/if}
		{/each}
	</Card>
</fieldset>
