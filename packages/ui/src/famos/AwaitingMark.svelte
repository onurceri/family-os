<script lang="ts">
	import { findApp } from '../app-context.js';

	/**
	 * "Waiting for approval" next to a row or a record when a change the signed-in member made to
	 * it waits for someone else to approve it, so the old value on screen is not mistaken for a
	 * change that was lost. Nothing otherwise.
	 */
	let { id }: { id: string } = $props();
	const app = findApp();
</script>

{#if app?.awaitsApproval(id)}
	<span class="text-ink-soft shrink-0 text-xs font-semibold" data-testid="approval-mark"
		>{app.t('app:draft_waiting')}</span
	>
{/if}
