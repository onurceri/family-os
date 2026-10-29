<script lang="ts">
	import { Button } from '@famos/ui/button';
	import { Card } from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { Search } from '@lucide/svelte';
	import type { Place, PlaceResult } from '../contract/index.js';
	import { searchPlaces } from './data.js';
	import { useAmbient } from './i18n.js';

	/** Searches Open-Meteo for a place by name and lets the person pick one. */
	const { t } = useAmbient();
	let {
		place = $bindable(null),
		busy = false,
		onerror,
		onsearch,
	}: {
		place: Place | null;
		/** The caller is busy (saving); the search button waits too. */
		busy?: boolean;
		/** A failed search; the caller shows the message. */
		onerror?: (message: string) => void;
		/** A search started; the caller clears what it showed before. */
		onsearch?: () => void;
	} = $props();

	let query = $state('');
	let results = $state<PlaceResult[] | null>(null);
	let searching = $state(false);

	async function search(event: SubmitEvent) {
		event.preventDefault();
		// Enter while a search runs would send another one.
		if (searching || query.trim().length < 2) return;
		searching = true;
		onsearch?.();
		try {
			results = await searchPlaces(query.trim());
		} catch {
			results = null;
			onerror?.(t('error'));
		} finally {
			searching = false;
		}
	}

	function choose(result: PlaceResult) {
		place = { name: result.label, latitude: result.latitude, longitude: result.longitude };
		results = null;
		query = '';
	}
</script>

<form onsubmit={search} class="grid gap-1.5">
	<Label for="weather-search">{t('weather_search')}</Label>
	<div class="flex gap-2">
		<Input
			id="weather-search"
			bind:value={query}
			maxlength={80}
			autocomplete="off"
			class="min-w-0 flex-1"
		/>
		<Button type="submit" variant="outline" disabled={busy || searching}>
			<Search class="size-4" />{t('weather_search_button')}
		</Button>
	</div>
</form>
{#if results}
	{#if results.length === 0}
		<p class="text-ink-soft text-sm">{t('weather_no_results')}</p>
	{:else}
		<Card rows aria-label={t('weather_search')}>
			{#each results as result (`${result.latitude},${result.longitude},${result.label}`)}
				<button
					type="button"
					class="flex min-h-12 w-full items-center px-4 py-3 text-left font-semibold"
					onclick={() => choose(result)}>{result.label}</button
				>
			{/each}
		</Card>
	{/if}
{/if}
