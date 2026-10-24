<script lang="ts">
	import { DraftView } from '@famos/ui/famos';
	import type { ComponentProps } from 'svelte';
	import { type Draft, draftCalls } from './data.js';
	import { useInbox } from './i18n.js';

	/** A draft in Quick add: the shared draft card with this extension's calls and words. */
	let props: Omit<
		ComponentProps<typeof DraftView<Draft>>,
		'calls' | 'texts' | 'pickLabel'
	> = $props();
	const { t } = useInbox();
</script>

<DraftView
	{...props}
	calls={draftCalls}
	texts={{ approved: t('approved'), error: t('error') }}
	pickLabel={(name) => t('pick_suggestion', { name })}
/>
