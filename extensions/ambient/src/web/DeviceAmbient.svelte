<script lang="ts">
	import { formatTime } from '@famos/time';
	import { useNow } from '@famos/ui/now';
	import Ambient from './Ambient.svelte';
	import { useAmbient } from './i18n.js';

	/**
	 * Ambient mode on a family device (a kitchen tablet, a photo frame): the display's cover, over
	 * the signed-in app, but only with photos. The app renders this only on a family device whose
	 * slideshow is on; the clock is the family's, written the reader's way.
	 */
	const { app } = useAmbient();
	const clock = useNow(10_000);

	const time = $derived(
		formatTime(clock.current, app.timeZone(), app.dateLocale(), app.hourCycle()),
	);
	const date = $derived(
		new Intl.DateTimeFormat(app.dateLocale(), {
			weekday: 'long',
			day: 'numeric',
			month: 'long',
			timeZone: app.timeZone(),
		}).format(clock.current),
	);
</script>

<Ambient {time} {date} photosOnly />
