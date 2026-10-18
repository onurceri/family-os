<script lang="ts">
	import { findApp } from '../app-context.js';
	import { awaitingMarkText } from './awaiting.js';

	/**
	 * "Waiting for approval" next to a row or a record when a change to it waits for approval: the
	 * signed-in member's own, or (for someone who may decide it) another person's, "Suggested by
	 * Leo". It is followed by what the change will make of it ("Due: Tue 20 Oct"), so the old value
	 * on screen is not mistaken for a change that was lost. The presenter of the change's action
	 * words it. Nothing otherwise.
	 */
	let { id }: { id: string } = $props();
	const app = findApp();
	const text = $derived.by(() => {
		const change = app?.awaitedChange(id);
		return app && change ? awaitingMarkText(app, change) : null;
	});
</script>

{#if text !== null}
	<span
		class="text-ink-soft max-w-full min-w-0 truncate text-xs font-semibold"
		title={text}
		data-testid="approval-mark">{text}</span
	>
{/if}
