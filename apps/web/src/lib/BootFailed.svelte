<script lang="ts">
	import { Button } from '@famos/ui/button';
	import { EmptyState, Page } from '@famos/ui/famos';
	import { t } from '#lib/i18n.svelte.js';
</script>

<Page template="list">
	<EmptyState art="generic" title={t('boot_failed_title')} hint={t('boot_failed_hint')}>
		<Button onclick={() => location.reload()}>{t('boot_failed_retry')}</Button>
	</EmptyState>
</Page>
