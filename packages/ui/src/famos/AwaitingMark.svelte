<script lang="ts">
	import { findApp } from '../app-context.js';
	import { awaitingMarkText } from './awaiting.js';

	/**
	 * "Waiting for approval" next to a row or a record when a change to it waits for approval: the
	 * signed-in member's own, or (for someone who may decide it) another person's, "Suggested by
	 * Leo". It is followed by what the change will make of it ("Due: Tue 20 Oct"), so the old value
	 * on screen is not mistaken for a change that was lost. The presenter of the change's action
	 * words it. It starts with the hourglass every waiting thing wears, and it wraps onto further
	 * lines instead of being cut, so "Waiting for approval to remove" is always whole. Nothing
	 * otherwise.
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
		class="text-ink-soft inline-flex max-w-full min-w-0 items-start gap-1 text-xs font-semibold"
		title={text}
		data-testid="approval-mark"
	>
		<svg
			class="mt-px size-3 shrink-0"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
			data-testid="approval-hourglass"
			><path
				d="M5 22h14M5 2h14M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2"
			/></svg
		>
		<span class="min-w-0 break-words">{text}</span>
	</span>
{/if}
