<script lang="ts">
	import { counterText, lengthState } from './length-limit.js';

	/**
	 * Shows how much of a limit a text has used, in the last few characters before it, and a
	 * message when it is over. The text is never cut: the person decides what to shorten.
	 */
	let {
		text,
		max,
		tooLong,
		id,
	}: {
		text: string;
		max: number;
		/** The message when over, e.g. "Too long (212/160)"; given the counter text. */
		tooLong: (counter: string) => string;
		id?: string;
	} = $props();

	const usage = $derived(lengthState(text, max));
</script>

{#if usage.counting}
	<p
		{id}
		class="text-xs tabular-nums {usage.over ? 'text-attention font-semibold' : 'text-ink-soft'}"
		role={usage.over ? 'alert' : undefined}
	>
		{usage.over ? tooLong(counterText(usage)) : counterText(usage)}
	</p>
{/if}
