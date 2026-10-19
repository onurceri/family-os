<script lang="ts">
	import { Card, Row, Section, SidePanel, SwitchRow } from '@famos/ui/famos';
	import { MapPin } from '@lucide/svelte';
	import type { AmbientSettings, Place } from '../contract/index.js';
	import { saveWeather } from './data.js';
	import { placeChoice } from './place-rule.js';
	import { useAmbient } from './i18n.js';
	import PlacePicker from './PlacePicker.svelte';

	/** Photos and weather: the weather on Today and displays (Open-Meteo, opt-in). Saved as you go. */
	const { app, t } = useAmbient();
	let {
		settings,
		onsaved,
	}: { settings: AmbientSettings; onsaved: (settings: AmbientSettings) => void } = $props();

	// svelte-ignore state_referenced_locally (the switch starts from the saved value)
	let enabled = $state(settings.weather.enabled);
	let picking = $state(false);
	let draft = $state<Place | null>(null);
	let busy = $state(false);
	let needPlace = $state(false);
	let message = $state<string | null>(null);

	async function save(next: { enabled: boolean; place: Place | null }, toast = t('weather_saved')) {
		message = null;
		if (next.enabled && !next.place) {
			enabled = false;
			message = t('weather_need_place');
			return false;
		}
		busy = true;
		try {
			onsaved(await saveWeather(next));
			app.toast(toast);
			return true;
		} catch {
			enabled = settings.weather.enabled;
			message = t('error');
			return false;
		} finally {
			busy = false;
		}
	}

	async function savePlace() {
		needPlace = !draft;
		if (!draft) return;
		const choice = placeChoice(settings.weather, draft);
		const toast = choice.firstPlace
			? t('weather_on_for', { name: draft.name })
			: t('weather_place_saved');
		if (await save({ enabled: choice.enabled, place: choice.place }, toast)) {
			enabled = choice.enabled;
			picking = false;
		}
	}
</script>

<Section label={t('weather_title')}>
	<Card rows>
		<SwitchRow
			id="weather-enabled"
			label={t('weather_enable')}
			hint={t('weather_privacy')}
			bind:checked={enabled}
			disabled={busy}
			onchange={(on) => save({ enabled: on, place: settings.weather.place })}
		/>
		<Row
			title={t('weather_place_label')}
			meta={settings.weather.place?.name ?? t('weather_place_none')}
			onclick={() => {
				draft = settings.weather.place;
				needPlace = false;
				picking = true;
			}}
			data-testid="weather-place"
		>
			{#snippet lead()}<MapPin class="size-5" aria-hidden="true" />{/snippet}
			{#snippet trail()}
				<span class="text-info text-sm font-semibold">{t('weather_choose')}</span>
			{/snippet}
		</Row>
	</Card>
	{#if message}<p class="text-attention text-sm font-semibold" role="alert">{message}</p>{/if}
</Section>

<SidePanel
	open={picking}
	title={t('weather_place_label')}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={t('weather_save')}
	saveDisabled={busy}
	onsave={savePlace}
	onclose={() => (picking = false)}
>
	<div class="grid gap-4">
		<PlacePicker bind:place={draft} onerror={(m) => (message = m)} {busy} />
		{#if draft}<p class="font-semibold">{t('weather_place', { name: draft.name })}</p>{/if}
		{#if needPlace && !draft}
			<p class="text-attention text-[13px] leading-snug font-semibold" role="alert">
				{t('weather_need_place')}
			</p>
		{/if}
	</div>
</SidePanel>
