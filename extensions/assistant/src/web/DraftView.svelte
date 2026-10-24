<script lang="ts">
	import { DraftView } from '@famos/ui/famos';
	import { type Draft, draftCalls } from './data.js';
	import { useAssistant } from './i18n.js';

	/**
	 * A draft the assistant created, shown under its answer with the normal draft card. A suggestion
	 * taken back and sent again replaces this card's draft; nothing is quoted or named for a
	 * message, as the assistant's drafts are not read from one.
	 */
	let { draft }: { draft: Draft } = $props();
	const { t } = useAssistant();
</script>

<DraftView
	{draft}
	quiet
	calls={draftCalls}
	texts={{ approved: t('approved'), error: t('error') }}
	suggestAgain="swap"
	nameSubject={false}
	showQuote={false}
	uncertainInEditor={false}
/>
