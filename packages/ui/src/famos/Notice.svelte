<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * A quiet row with an icon and a sentence: previews,
	 * server-set values and warnings inside the form that needs them. `warn` is `heat`, `alert` is
	 * `attention`; an alert is announced.
	 */
	let {
		tone = 'info',
		icon,
		children,
	}: {
		tone?: 'info' | 'warn' | 'alert';
		/** Replaces the default icon of the tone. */
		icon?: Snippet;
		children: Snippet;
	} = $props();
</script>

<div class="notice {tone}" role={tone === 'alert' ? 'alert' : undefined}>
	<span class="ic" aria-hidden="true">
		{#if icon}
			{@render icon()}
		{:else}
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="1.75"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				{#if tone === 'warn'}
					<path
						d="m21.7 18-8-14a2 2 0 0 0-3.5 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3M12 9v4M12 17h.01"
					/>
				{:else if tone === 'alert'}
					<circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" />
				{:else}
					<circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
				{/if}
			</svg>
		{/if}
	</span>
	<span class="txt">{@render children()}</span>
</div>

<style>
	.notice {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 12px 14px;
		border-radius: var(--r-item);
		background: var(--idle);
		color: var(--ink);
		font-size: 14px;
		line-height: 1.4;
	}
	.ic {
		display: inline-flex;
		flex: none;
		margin-top: 1px;
		color: var(--info);
	}
	.ic :global(svg) {
		width: 18px;
		height: 18px;
	}
	.warn .ic {
		color: var(--heat);
	}
	.alert .ic {
		color: var(--attention);
	}
	.txt {
		min-width: 0;
	}
</style>
