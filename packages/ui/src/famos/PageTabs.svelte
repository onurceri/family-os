<script lang="ts">
	/**
	 * Tabs that split a long page into parts (settings pages above all). The page keeps the
	 * chosen tab in its address (`?tab=`), so a link or Back opens the same part. Arrow keys move
	 * between tabs (WAI-ARIA tabs pattern); the panel is the page's own content below.
	 */
	let {
		tabs,
		current,
		onselect,
		label,
	}: {
		tabs: readonly { id: string; label: string }[];
		current: string;
		onselect: (id: string) => void;
		/** What the tabs are about, for screen readers. */
		label: string;
	} = $props();

	let bar: HTMLDivElement | undefined = $state();

	function onkeydown(event: KeyboardEvent) {
		const index = tabs.findIndex((t) => t.id === current);
		const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
		if (!step || index < 0) return;
		event.preventDefault();
		const next = tabs[(index + step + tabs.length) % tabs.length];
		if (!next) return;
		onselect(next.id);
		bar?.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus();
	}
</script>

<!--
	The tabs scroll sideways on a narrow screen and never up and down. The strip's line is an inset
	shadow, so the chosen tab's underline covers it from inside the strip: nothing pokes out below
	(a tab one pixel over the edge gave the strip a vertical scrollbar).
-->
<div
	bind:this={bar}
	role="tablist"
	aria-label={label}
	tabindex="-1"
	class="mb-6 flex gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--border)]"
	data-scroll-x
	{onkeydown}
>
	{#each tabs as tab (tab.id)}
		{@const on = tab.id === current}
		<button
			type="button"
			role="tab"
			data-tab={tab.id}
			aria-selected={on}
			tabindex={on ? 0 : -1}
			onclick={() => onselect(tab.id)}
			class="focus-visible:ring-ring min-h-11 shrink-0 border-b-2 px-3 text-[0.9375rem] font-semibold whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-inset {on
				? 'border-ink text-ink'
				: 'text-ink-soft hover:text-ink border-transparent'}">{tab.label}</button
		>
	{/each}
</div>
