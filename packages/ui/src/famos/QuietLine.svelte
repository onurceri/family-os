<script lang="ts">
	/**
	 * The quiet line of Today: what is not there, in one calm sentence with a `now` check.
	 * Polite live region, so a ticked chore reads as "That is all for today: no chores".
	 */
	let { text, testid = 'quiet-line' }: { text: string; testid?: string } = $props();
</script>

<p
	class="text-ink-soft flex min-h-5 items-start gap-2.5 text-sm"
	aria-live="polite"
	data-testid={testid}
>
	{#if text}
		<svg
			class="text-now mt-0.5 size-4 shrink-0"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="3"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg
		>
		<span>{text}</span>
	{/if}
</p>
