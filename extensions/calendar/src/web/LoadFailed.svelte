<script lang="ts">
	import { Button } from '@famos/ui/button';
	import { Notice } from '@famos/ui/famos';
	import { useCalendar } from './i18n.js';

	/** A list that could not be read: says so and offers another try. */
	const { onretry }: { onretry: () => void } = $props();
	const { t } = useCalendar();
</script>

<div class="grid gap-2" role="alert">
	<Notice tone="alert">{t('load_failed')}</Notice>
	<div>
		<Button variant="outline" size="sm" onclick={onretry}>{t('load_retry')}</Button>
	</div>
</div>
