<script lang="ts">
	import { Textarea } from '@famos/ui/textarea';
	import {
		Card,
		fieldAria,
		FieldError,
		type FieldErrors,
		MemberChips,
		ScheduleFields,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { presetsFor } from '../contract/index.js';
	import { type PetFormValue, type PresetPicks, sexes, species } from './form.js';
	import { usePets } from './i18n.js';

	/**
	 * The pet form (it opens in the side panel or the phone sheet). When adding, `picks` shows
	 * "what usually needs doing" (the presets that suit the species) as a checklist with a first
	 * due date for each ticked one; when changing a pet, duties are managed on its page.
	 */
	let {
		value = $bindable(),
		picks = $bindable(),
		errors = {},
		idPrefix = 'pet',
	}: {
		value: PetFormValue;
		picks?: PresetPicks;
		errors?: FieldErrors;
		idPrefix?: string;
	} = $props();

	const { app, t } = usePets();
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
	const field =
		'border-line bg-wall text-ink focus-visible:border-info focus-visible:ring-info/25 h-[var(--ctl)] w-full rounded-[var(--r-ctl)] border px-3 text-[15px] outline-none focus-visible:ring-3';
	const suggested = $derived(presetsFor(value.species));
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
		<small class="text-ink-soft text-[13px]">{t('field_name_hint')}</small>
	</div>

	<div class="grid grid-cols-2 gap-x-3 gap-y-[18px]">
		<div class="grid content-start gap-1.5">
			<Label for={id('species')}>{t('field_species')}</Label>
			<select id={id('species')} bind:value={value.species} class={field}>
				{#each species as s (s)}<option value={s}>{t(`species_${s}`)}</option>{/each}
			</select>
		</div>
		<div class="grid content-start gap-1.5">
			<Label for={id('breed')}>{t('field_breed')} {@render optional()}</Label>
			<Input id={id('breed')} bind:value={value.breed} maxlength={80} autocomplete="off" />
		</div>
		<div class="grid content-start gap-1.5">
			<Label for={id('sex')}>{t('field_sex')}</Label>
			<select id={id('sex')} bind:value={value.sex} class={field}>
				<option value="">{t('sex_unknown')}</option>
				{#each sexes as s (s)}<option value={s}>{t(`sex_${s}`)}</option>{/each}
			</select>
		</div>
		<div class="grid content-start gap-1.5">
			<Label for={id('birth')}>{t('field_birth_date')} {@render optional()}</Label>
			<Input id={id('birth')} type="date" bind:value={value.birthDate} />
		</div>
		<div class="col-span-2 grid gap-1.5">
			<Label for={id('chip')}>{t('field_chip')} {@render optional()}</Label>
			<Input
				id={id('chip')}
				bind:value={value.chipNumber}
				maxlength={40}
				inputmode="numeric"
				autocomplete="off"
			/>
		</div>
		<div class="col-span-2 grid gap-1.5">
			<Label for={id('vet')}>{t('field_vet')} {@render optional()}</Label>
			<Input id={id('vet')} bind:value={value.vet} maxlength={300} autocomplete="off" />
			<small class="text-ink-soft text-[13px]">{t('field_vet_hint')}</small>
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
				{#each suggested as preset (preset.id)}
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
									id="preset-{preset.id}-due"
									{...fieldAria(errors[`preset_${preset.id}`], `preset-${preset.id}-due`)}
									class="max-w-56"
								/>
								<FieldError for="preset-{preset.id}-due" error={errors[`preset_${preset.id}`]} />
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
