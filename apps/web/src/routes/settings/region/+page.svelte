<script lang="ts">
	import { goto } from '$app/navigation';
	import { unwrap } from '@famos/api-client';
	import {
		canonicalLocale,
		dateLocale,
		defaultHourCycle,
		defaultTemperatureUnit,
		defaultWeekStart,
		isFormatLocale,
	} from '@famos/time';
	import { Button } from '@famos/ui/button';
	import { Card, Combobox, Notice, Page, PageHeader, Segmented, SettingRow } from '@famos/ui/famos';
	import { api } from '#lib/api.js';
	import { browserFormatLocale, browserLocales, family } from '#lib/family.svelte.js';
	import { getLanguages, getLocale, t } from '#lib/i18n.svelte.js';
	import { regionOptions, startingFormatLocales, timeZoneOptions } from '#lib/region.js';
	import SelectField from '#lib/SelectField.svelte';
	import { session } from '#lib/session.svelte.js';
	import { toasts } from '#lib/toast.svelte.js';
	import LanguagesSection from './LanguagesSection.svelte';

	/**
	 * Language & region: the family language and the region formats, which are
	 * separate (the language only chooses words), then the language packs. Every choice is saved as
	 * soon as it is made.
	 */
	let formatLocale = $state(family.formatLocale);
	let weekStart = $state(family.weekStart);
	let hourCycle = $state<'h12' | 'h23'>(family.hourCycle);
	let temperatureUnit = $state<'celsius' | 'fahrenheit'>(family.temperatureUnit);
	let timeZone = $state(family.timeZone);
	let error = $state<string | null>(null);

	const allZones = timeZoneOptions();
	const zoneValid = $derived(allZones.some((z) => z.value === timeZone));
	const zoneNow = $derived.by(() => {
		try {
			return new Intl.DateTimeFormat(shown, { timeStyle: 'short', timeZone, hourCycle }).format(
				new Date(),
			);
		} catch {
			return '';
		}
	});

	// Every region the browser knows, named in the reader's language; any valid BCP 47 tag is
	// accepted too, and the saved one and the browser's are always offered.
	const regions = $derived(
		regionOptions(getLocale(), startingFormatLocales(family.formatLocale, browserLocales())),
	);
	const valid = $derived(isFormatLocale(formatLocale));
	const tag = $derived(valid ? canonicalLocale(formatLocale) : family.formatLocale);
	/** Dates and times as they will be read: the reader's words, the chosen region's order. */
	const shown = $derived(dateLocale(getLocale(), tag, hourCycle));

	$effect(() => {
		if (session.status === 'ready' && !session.can('core.settings.manage'))
			void goto('/', { replace: true });
	});

	/** Takes the week, clock and temperature a region uses; the person can still change them. */
	function useRegionDefaults() {
		if (!valid) return;
		weekStart = defaultWeekStart(tag);
		hourCycle = defaultHourCycle(tag);
		temperatureUnit = defaultTemperatureUnit(tag);
	}

	const sample = Date.UTC(2026, 9, 8, 14, 30);
	const preview = $derived.by(() => {
		const date = new Intl.DateTimeFormat(shown, { dateStyle: 'full', timeZone: 'UTC' }).format(
			sample,
		);
		const time = new Intl.DateTimeFormat(shown, {
			hour: '2-digit',
			minute: '2-digit',
			hourCycle,
			timeZone: 'UTC',
		}).format(sample);
		const number = new Intl.NumberFormat(tag).format(1234.56);
		const temperature = new Intl.NumberFormat(tag, {
			style: 'unit',
			unit: temperatureUnit,
		}).format(temperatureUnit === 'celsius' ? 21 : 70);
		return `${date} · ${time} · ${number} · ${temperature}`;
	});
	/** The all-numeric form, where day-month order differs the most between regions. */
	const numericDate = $derived(
		new Intl.DateTimeFormat(tag, {
			day: '2-digit',
			month: '2-digit',
			year: 'numeric',
			timeZone: 'UTC',
		}).format(sample),
	);
	/** Monday, Saturday and Sunday are the usual first days; the current one is always offered. */
	const weekOptions = $derived.by(() => {
		const monday = Date.UTC(2026, 0, 5, 12);
		const fmt = new Intl.DateTimeFormat(shown, { weekday: 'short', timeZone: 'UTC' });
		const day = (n: number) => ({
			value: String(n),
			label: fmt.format(monday + (n - 1) * 86_400_000),
		});
		const days = [1, 6, 7];
		if (!days.includes(weekStart)) days.push(weekStart);
		return days.toSorted((a, b) => a - b).map(day);
	});

	/** Saves every region setting; called after each change. */
	async function save() {
		if (!valid || !zoneValid) return;
		error = null;
		try {
			const result = unwrap(
				await api.POST('/api/v1/actions/core.updateFamilySettings', {
					body: { timeZone, formatLocale: tag, weekStart, hourCycle, temperatureUnit },
				}),
			);
			if (result.status === 'applied') {
				family.apply(result.output);
				family.timeZone = result.output.timeZone;
				formatLocale = result.output.formatLocale;
			}
			toasts.show(t('region_saved'));
		} catch {
			error = t('error_generic');
		}
	}

	async function chooseFamilyLanguage(locale: string) {
		error = null;
		try {
			const result = unwrap(
				await api.POST('/api/v1/actions/core.updateFamilySettings', { body: { locale } }),
			);
			if (result.status === 'applied') family.locale = result.output.locale;
			toasts.show(t('languages_saved'));
		} catch {
			error = t('error_generic');
		}
	}

	function useBrowser() {
		formatLocale = browserFormatLocale();
		useRegionDefaults();
		void save();
	}
</script>

<Page template="settings">
	<PageHeader title={t('nav_language_region')} />

	<div class="grid gap-7">
		<Notice>
			<span class="font-bold">{t('region_preview')}</span> ·
			<span data-testid="region-preview">{preview}</span>
			<span class="sr-only" data-testid="region-numeric-date">{numericDate}</span>
		</Notice>

		<div class="grid gap-3">
			<Card rows>
				<SettingRow
					label={t('languages_family_default')}
					for="family-language"
					hint={t('languages_family_default_hint')}
				>
					{#snippet control()}
						<SelectField
							id="family-language"
							value={family.locale}
							onchange={(e) => chooseFamilyLanguage(e.currentTarget.value)}
						>
							{#each getLanguages() as language (language.code)}
								<option value={language.code} lang={language.code}>{language.nativeName}</option>
							{/each}
						</SelectField>
					{/snippet}
				</SettingRow>

				<SettingRow
					label={t('region_time_zone')}
					for="time-zone"
					hint={`${t('region_time_zone_hint')} ${t('region_time_zone_now', { time: zoneNow })}`}
				>
					{#snippet control()}
						<Combobox
							id="time-zone"
							bind:value={timeZone}
							options={allZones}
							onpick={() => void save()}
							onchange={() => void save()}
							invalid={!zoneValid}
							placeholder={t('region_time_zone_search')}
							max={80}
						/>
					{/snippet}
				</SettingRow>

				<SettingRow
					label={t('region_locale')}
					for="format-locale"
					hint={valid ? t('region_locale_hint') : t('region_locale_invalid')}
				>
					{#snippet control()}
						<div class="grid gap-1">
							<Combobox
								id="format-locale"
								bind:value={formatLocale}
								options={regions}
								placeholder={t('region_locale_search')}
								max={300}
								onpick={() => {
									useRegionDefaults();
									void save();
								}}
								onchange={() => {
									useRegionDefaults();
									void save();
								}}
								invalid={!valid}
							/>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								class="justify-self-start"
								onclick={useBrowser}>{t('region_use_browser')}</Button
							>
						</div>
					{/snippet}
				</SettingRow>

				<SettingRow label={t('region_week_start')}>
					{#snippet control()}
						<Segmented
							grow
							label={t('region_week_start')}
							options={weekOptions}
							value={String(weekStart)}
							onchange={(v) => {
								weekStart = Number(v);
								void save();
							}}
						/>
					{/snippet}
				</SettingRow>

				<SettingRow label={t('region_hour_cycle')}>
					{#snippet control()}
						<Segmented
							grow
							label={t('region_hour_cycle')}
							options={[
								{ value: 'h23', label: t('region_hour_24_short') },
								{ value: 'h12', label: t('region_hour_12_short') },
							]}
							value={hourCycle}
							onchange={(v) => {
								hourCycle = v as 'h12' | 'h23';
								void save();
							}}
						/>
					{/snippet}
				</SettingRow>

				<SettingRow label={t('region_temperature')}>
					{#snippet control()}
						<Segmented
							grow
							label={t('region_temperature')}
							options={[
								{ value: 'celsius', label: '°C' },
								{ value: 'fahrenheit', label: '°F' },
							]}
							value={temperatureUnit}
							onchange={(v) => {
								temperatureUnit = v as 'celsius' | 'fahrenheit';
								void save();
							}}
						/>
					{/snippet}
				</SettingRow>
			</Card>
			<p class="text-ink-soft px-1 text-[13px]">{t('settings_saved_as_you_go')}</p>
			{#if error}<p class="text-attention font-semibold" role="alert">{error}</p>{/if}
		</div>

		<LanguagesSection />
	</div>
</Page>
