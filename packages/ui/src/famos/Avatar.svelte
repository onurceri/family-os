<script lang="ts">
	import { initialOf } from './initial.js';
	import { onMemberColor } from './on-member-color.js';

	/**
	 * A family member: their color and initial. `size` in px. `anyone`: things for no one in
	 * particular get a neutral people icon on `idle`, never a letter (which would read as a
	 * member's initial).
	 */
	let {
		name,
		color,
		size = 36,
		anyone = false,
	}: { name: string; color: string; size?: number; anyone?: boolean } = $props();
</script>

{#if anyone}
	<span
		class="anyone bg-idle text-ink-soft inline-flex shrink-0 items-center justify-center rounded-full select-none"
		style:width="{size}px"
		style:height="{size}px"
		aria-hidden="true"
		data-testid="anyone-avatar"
		><svg
			viewBox="0 0 24 24"
			width={Math.round(size * 0.58)}
			height={Math.round(size * 0.58)}
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path
				d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14a6.5 6.5 0 0 1 3 6"
			/></svg
		></span
	>
{:else}
	<span
		class="day inline-flex shrink-0 items-center justify-center rounded-full font-bold select-none"
		style:background-color={color}
		style:color={onMemberColor(color)}
		style:width="{size}px"
		style:height="{size}px"
		style:font-size="{Math.round(size * 0.42)}px"
		aria-hidden="true">{initialOf(name)}</span
	>
{/if}
