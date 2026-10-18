<script lang="ts">
	import type { SlotProps } from '@famos/ui/slots';
	import { onDestroy } from 'svelte';
	import { DEFAULT_TIMING, type PhotoList } from '../contract/index.js';
	import { loadPhotos } from './data.js';
	import { useAmbient } from './i18n.js';
	import Slideshow from './Slideshow.svelte';

	/**
	 * Family display page: the family's photos one after the other, with the date over them,
	 * at the size of a page (the page's head already has the time). On a screen that has pages this is
	 * how the photos come, since ambient mode does not take such a screen over. Without photos it
	 * is a calm clock. Nothing on it can be pressed; it reads the photos again each time it comes
	 * round and when they change.
	 */
	let { shown }: SlotProps['display.page'] = $props();
	const { app, t } = useAmbient();

	let photos = $state<PhotoList | null>(null);
	let loaded = $state(false);
	let photo = $state<string | null>(null);
	let now = $state(Date.now());
	const clock = setInterval(() => (now = Date.now()), 30_000);
	onDestroy(() => clearInterval(clock));

	async function load() {
		try {
			photos = await loadPhotos();
		} catch {
			// Keep what is there; the next reading tries again.
		}
		loaded = true;
	}

	$effect(() => {
		if (!shown) return;
		void load();
		const off = app.onEvent('ambient.', () => void load());
		return off;
	});

	const timing = $derived(photos?.timing ?? DEFAULT_TIMING);
	const date = $derived(
		new Intl.DateTimeFormat(app.dateLocale(), {
			weekday: 'long',
			day: 'numeric',
			month: 'long',
			timeZone: app.timeZone(),
		}).format(now),
	);
	const hasPhoto = $derived(photo !== null);
</script>

<div
	class="relative size-full overflow-hidden rounded-lg {hasPhoto
		? 'day bg-backdrop text-on-color'
		: 'bg-idle text-ink'}"
	data-testid="photos-page"
>
	<Slideshow
		ids={photos?.ids ?? []}
		seconds={timing.slideSeconds}
		running={shown}
		bind:shown={photo}
	/>
	{#if hasPhoto}
		<!-- The scrim keeps white text readable on any photo, in light and dark themes. -->
		<div class="from-scrim absolute inset-x-0 bottom-0 h-1/2 bg-linear-to-t to-transparent"></div>
	{/if}
	{#if loaded}
		<div
			class="relative z-10 grid size-full gap-2 p-8 {hasPhoto
				? 'content-end drop-shadow-lg'
				: 'content-center justify-items-center text-center'}"
		>
			<p class="text-3xl font-bold capitalize">{date}</p>
			{#if !hasPhoto && (photos?.ids.length ?? 0) === 0}
				<p class="text-ink-soft text-xl">{t('photos_page_none')}</p>
			{/if}
		</div>
	{/if}
</div>
