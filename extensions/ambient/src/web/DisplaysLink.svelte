<script lang="ts">
	import { useAmbient } from './i18n.js';
	import { SETTINGS_PATH } from './today.js';

	/** Settings, Devices and displays: the photos, the weather and the slideshow have a page of their own. */
	const { t } = useAmbient();
</script>

<p class="text-ink-soft px-1 text-sm" data-testid="photos-weather-link">
	{t('devices_line')}
	<a class="text-info font-semibold underline underline-offset-2" href={SETTINGS_PATH}
		>{t('nav_photos_weather')}</a
	>
</p>
