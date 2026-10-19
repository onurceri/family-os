<script lang="ts">
	import { Button } from '@famos/ui/button';
	import type { Place } from '../contract/index.js';
	import { saveWeather } from './data.js';
	import { useAmbient } from './i18n.js';
	import PlacePicker from './PlacePicker.svelte';

	/**
	 * First-run setup (`setup.step`): where the family lives, only for the weather. Optional: Skip
	 * always works, and a failure never blocks setup.
	 */
	const { t } = useAmbient();
	let { done }: { done: () => void } = $props();

	let place = $state<Place | null>(null);
	let busy = $state(false);
	let message = $state<string | null>(null);

	async function save() {
		message = null;
		if (!place) {
			message = t('weather_need_place');
			return;
		}
		busy = true;
		try {
			await saveWeather({ enabled: true, place });
			done();
		} catch {
			message = t('error');
			busy = false;
		}
	}
</script>

<div class="grid gap-5" role="group" aria-labelledby="setup-place-title">
	<div class="grid gap-2">
		<h1 id="setup-place-title" class="text-2xl font-extrabold tracking-tight">
			{t('setup_place_title')}
		</h1>
		<p class="text-ink-soft">{t('setup_place_intro')}</p>
	</div>
	<PlacePicker bind:place {busy} onerror={(m) => (message = m)} />
	{#if place}<p class="font-semibold" data-testid="setup-place">
			{t('weather_place', { name: place.name })}
		</p>{/if}
	{#if message}<p class="text-attention text-sm font-semibold" role="alert">{message}</p>{/if}
	<Button type="button" disabled={busy} onclick={save}>{t('setup_place_save')}</Button>
	<Button type="button" variant="ghost" disabled={busy} onclick={done}
		>{t('setup_place_skip')}</Button
	>
	<p class="text-ink-soft text-sm">{t('setup_place_later')}</p>
</div>
