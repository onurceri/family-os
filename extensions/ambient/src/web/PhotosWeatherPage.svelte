<script lang="ts">
	import { Page, PageHeader } from '@famos/ui/famos';
	import DisplayContent from './DisplayContent.svelte';
	import { useAmbient } from './i18n.js';

	/**
	 * Settings, Family, Photos and weather: the photos and the weather that Today and family
	 * displays show, and the slideshow's timing. Devices and displays links here. Only those who
	 * may manage them see what is on it.
	 */
	const { app, t } = useAmbient();
</script>

<Page template="settings">
	<PageHeader title={t('nav_photos_weather')} />

	<div class="grid gap-7">
		{#if app.can('ambient.manage')}<DisplayContent />{/if}
	</div>
</Page>
