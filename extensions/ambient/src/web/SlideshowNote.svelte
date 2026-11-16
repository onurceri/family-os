<script lang="ts">
	import { loadLibrary } from './data.js';
	import { useAmbient } from './i18n.js';
	import { showNoPhotosNote } from './slideshow-note.js';
	import { SETTINGS_PATH } from './today.js';

	/**
	 * Under the photo switch of a family device in Settings → Devices: with no photos in the
	 * library nothing ever covers the screen, so this says why and links to where they are added.
	 * With photos (or before they are read) it shows nothing.
	 */
	const { app, t } = useAmbient();

	let count = $state<number | null>(null);

	async function load() {
		try {
			count = (await loadLibrary()).length;
		} catch {
			// Say nothing rather than something wrong.
		}
	}

	$effect(() => {
		void load();
		return app.onEvent('ambient.', () => void load());
	});
</script>

{#if showNoPhotosNote(count)}
	<p class="text-ink-soft mt-2 px-1 text-sm" data-testid="slideshow-no-photos">
		{t('devices_no_photos')}
		<a class="text-info font-semibold underline underline-offset-2" href={SETTINGS_PATH}
			>{t('nav_photos_weather')}</a
		>
	</p>
{/if}
