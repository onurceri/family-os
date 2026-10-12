<script lang="ts">
	import { Textarea } from '@famos/ui/textarea';
	import { Card, MemberChips, ScheduleFields } from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { VEHICLE_PRESETS } from '../contract/index.js';
	import { fuels, type PresetPicks, type VehicleFormValue } from './form.js';
	import { useVehicles } from './i18n.js';

	/**
	 * The vehicle form (it opens in the side panel or the phone sheet). When adding, `picks` shows
	 * "what usually needs doing" (the presets) as a checklist with a first due date for each ticked
	 * one; when changing a vehicle, duties are managed on its page.
	 */
	let {
		value = $bindable(),
		picks = $bindable(),
		errors = {},
		idPrefix = 'vehicle',
	}: {
		value: VehicleFormValue;
		picks?: PresetPicks;
		errors?: Record<string, true>;
		idPrefix?: string;
	} = $props();

	const { app, t } = useVehicles();
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
	const id = (name: string) => `${idPrefix}-${name}`;
	const flag = (path: string) => (errors[path] ? 'true' : undefined);
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
			aria-invalid={flag('name')}
		/>
		<small class="text-ink-soft text-[13px]">{t('field_name_hint')}</small>
	</div>

	<div class="grid grid-cols-2 gap-x-3 gap-y-[18px]">
		<div class="grid content-start gap-1.5">
			<Label for={id('plate')}>{t('field_plate')}</Label>
			<Input id={id('plate')} bind:value={value.plate} maxlength={20} autocomplete="off" />
		</div>
		<div class="grid content-start gap-1.5">
			<Label for={id('fuel')}>{t('field_fuel')}</Label>
			<select id={id('fuel')} bind:value={value.fuel} class={field}>
				{#each fuels as fuel (fuel)}<option value={fuel}>{t(`fuel_${fuel}`)}</option>{/each}
			</select>
		</div>
		<div class="grid content-start gap-1.5">
			<Label for={id('make')}>{t('field_make')} {@render optional()}</Label>
			<Input id={id('make')} bind:value={value.make} maxlength={60} autocomplete="off" />
		</div>
		<div class="grid content-start gap-1.5">
			<Label for={id('model')}>{t('field_model')} {@render optional()}</Label>
			<Input id={id('model')} bind:value={value.model} maxlength={60} autocomplete="off" />
		</div>
		<div class="grid content-start gap-1.5">
			<Label for={id('year')}>{t('field_year')} {@render optional()}</Label>
			<Input
				id={id('year')}
				bind:value={value.year}
				inputmode="numeric"
				maxlength={4}
				autocomplete="off"
				aria-invalid={flag('year')}
			/>
		</div>
		<div class="grid content-start gap-1.5">
			<Label for={id('vin')}>{t('field_vin')} {@render optional()}</Label>
			<Input id={id('vin')} bind:value={value.vin} maxlength={40} autocomplete="off" />
		</div>
	</div>

	<fieldset class="grid gap-2">
		<legend class="mb-1.5 text-sm font-medium">{t('field_members')}</legend>
		<MemberChips members={app.members()} bind:selected={value.memberIds} multiple />
	</fieldset>

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
		<fieldset class="grid gap-2">
			<legend class="mb-1 text-sm font-medium">
				{t('presets_title')} <span class="text-ink-soft font-normal">{t('presets_hint')}</span>
			</legend>
			<Card rows>
				{#each VEHICLE_PRESETS as preset (preset.id)}
					{@const pick = picks[preset.id]}
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
								<small class="text-ink-soft text-[13px] font-normal">{app.t(preset.labelKey)}</small
								>
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
				{/each}
			</Card>
		</fieldset>
	{/if}
</div>
