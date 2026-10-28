<script lang="ts">
	import type { EmptyArtName } from './empty-art.js';

	/**
	 * A small line drawing for an empty page, one per area, all in one hand: 120 x 88, rounded
	 * 1.75 px strokes in `currentColor`, a soft `idle` ground, the shapes in `surface` and one
	 * accent in a soft `sun`. Only tokens, so every theme pack and night mode draw it right.
	 */
	let { name }: { name: EmptyArtName } = $props();
</script>

<svg
	class="art"
	viewBox="0 0 120 88"
	width="120"
	height="88"
	fill="none"
	stroke="currentColor"
	stroke-width="1.75"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
	focusable="false"
	data-art={name}
>
	<ellipse class="ground" cx="60" cy="50" rx="48" ry="31" />
	{#if name === 'calendar'}
		<rect class="paper" x="32" y="20" width="56" height="50" rx="7" />
		<path d="M32 33h56M45 14v11M75 14v11" />
		<rect class="accent" x="61" y="49" width="11" height="10" rx="2.5" />
		<g class="dot">
			<circle cx="42" cy="43" r="1.6" /><circle cx="54" cy="43" r="1.6" />
			<circle cx="66" cy="43" r="1.6" /><circle cx="78" cy="43" r="1.6" />
			<circle cx="42" cy="54" r="1.6" /><circle cx="54" cy="54" r="1.6" />
			<circle cx="78" cy="54" r="1.6" /><circle cx="42" cy="63" r="1.6" />
			<circle cx="54" cy="63" r="1.6" /><circle cx="66" cy="63" r="1.6" />
		</g>
	{:else if name === 'tasks'}
		<rect class="paper" x="36" y="16" width="48" height="58" rx="6" />
		<rect class="paper" x="50" y="11" width="20" height="9" rx="3" />
		<rect class="accent" x="44" y="29" width="9" height="9" rx="2.5" />
		<path d="M46 33.5l2 2 3.5-4" />
		<rect x="44" y="43" width="9" height="9" rx="2.5" />
		<rect x="44" y="57" width="9" height="9" rx="2.5" />
		<path d="M59 33.5h17M59 47.5h13M59 61.5h15" />
	{:else if name === 'shopping'}
		<circle class="accent" cx="70" cy="31" r="9" />
		<path d="M70 22c0-3 1-5 3-6M70 22c3-4 7-4 9-2-3 2-6 3-9 2" />
		<path class="paper" d="M36 36h48l-4 36H40z" />
		<path d="M49 36v-5a11 11 0 0 1 22 0v5" />
		<path d="M48 48h24" />
	{:else if name === 'board'}
		<rect class="paper" x="22" y="18" width="76" height="52" rx="6" />
		<rect class="accent" x="33" y="27" width="23" height="21" rx="2" transform="rotate(-5 44 37)" />
		<rect class="paper" x="62" y="30" width="25" height="24" rx="2" transform="rotate(4 74 42)" />
		<path d="M67 40h14M67 46h10" transform="rotate(4 74 42)" />
		<path d="M38 36h11M38 41h8" transform="rotate(-5 44 37)" />
		<g class="dot"><circle cx="44" cy="27" r="2.2" /><circle cx="75" cy="30" r="2.2" /></g>
		<path d="M30 62h18" />
	{:else if name === 'chores'}
		<path class="paper" d="M41 42h38l-4 30H45z" />
		<path d="M44 42a16 16 0 0 1 32 0M41 50h38" />
		<path class="accent" d="M85 14q1.5 6.5 8 8q-6.5 1.5-8 8q-1.5-6.5-8-8q6.5-1.5 8-8z" />
		<path d="M33 22q1 4 5 5q-4 1-5 5q-1-4-5-5q4-1 5-5z" />
		<circle cx="52" cy="18" r="3" /><circle cx="61" cy="13" r="2" />
	{:else if name === 'vehicles'}
		<path
			class="paper"
			d="M24 60V50a5 5 0 0 1 4-5l10-3 9-11a6 6 0 0 1 5-2h18a6 6 0 0 1 5 2l9 11 8 2a5 5 0 0 1 4 5v11z"
		/>
		<path class="accent" d="M51 41l5-7h7v7zM67 34h5l5 7H67z" />
		<circle class="paper" cx="42" cy="60" r="7" /><circle class="paper" cx="78" cy="60" r="7" />
		<path d="M20 74h12M42 74h36M88 74h12" />
	{:else if name === 'home'}
		<path class="paper" d="M38 44L60 25l22 19v26H38z" />
		<path d="M32 49L60 24l28 25M72 33v-8h6v13" />
		<path d="M54 70V58a6 6 0 0 1 12 0v12" />
		<rect class="accent" x="43" y="48" width="9" height="9" rx="2" />
		<path d="M47.5 48v9M43 52.5h9" />
		<path d="M24 70h72" />
	{:else if name === 'pets'}
		<path class="paper" d="M43 43l-2-18 14 9zM77 43l2-18-14 9z" />
		<path class="accent" stroke="none" d="M45 38l-1.5-9 7.5 5zM75 38l1.5-9-7.5 5z" />
		<circle class="paper" cx="60" cy="51" r="20" />
		<g class="dot"><circle cx="53" cy="48" r="2" /><circle cx="67" cy="48" r="2" /></g>
		<path class="accent" d="M56.5 55h7l-3.5 3.5z" />
		<path d="M60 58.5v2a3.5 3.5 0 0 1-4.5 2.5M60 60.5a3.5 3.5 0 0 0 4.5 2.5" />
		<path d="M38 54l10 1.5M38 60l10-1.5M82 54l-10 1.5M82 60l-10-1.5" />
	{:else if name === 'kitchen'}
		<path class="paper" d="M36 46h48v16a10 10 0 0 1-10 10H46a10 10 0 0 1-10-10z" />
		<path d="M32 46h56M36 53h-6M84 53h6M55 46v-3h10v3" />
		<path d="M50 36c-3-4 3-6 0-10M60 36c-3-4 3-6 0-10" />
		<path
			class="accent"
			d="M72 34c-5-3-7-6-5-8.5 1.5-1.5 3.5-1 5 1 1.5-2 3.5-2.5 5-1 2 2.5 0 5.5-5 8.5z"
		/>
	{:else if name === 'assistant'}
		<path
			class="paper"
			d="M28 28a8 8 0 0 1 8-8h40a8 8 0 0 1 8 8v22a8 8 0 0 1-8 8H52l-10 9v-9h-6a8 8 0 0 1-8-8z"
		/>
		<g class="dot">
			<circle cx="45" cy="39" r="2.2" /><circle cx="56" cy="39" r="2.2" /><circle
				cx="67"
				cy="39"
				r="2.2"
			/>
		</g>
		<path class="accent" d="M90 12q1.5 6.5 8 8q-6.5 1.5-8 8q-1.5-6.5-8-8q6.5-1.5 8-8z" />
	{:else if name === 'quick-add'}
		<path class="paper" d="M38 16h28l14 14v42H38z" />
		<path d="M66 16v14h14M46 40h20M46 48h26M46 56h16" />
		<circle class="accent" cx="80" cy="64" r="11" />
		<path d="M80 59v10M75 64h10" />
	{:else if name === 'devices'}
		<rect class="paper" x="24" y="20" width="56" height="36" rx="4" />
		<circle class="accent" cx="38" cy="32" r="5" />
		<path d="M28 51l12-9 9 6 8-5 13 8M52 56v8M44 64h16" />
		<rect class="paper" x="74" y="36" width="22" height="36" rx="4" />
		<path d="M82 40h6" />
	{:else}
		<path class="paper" d="M36 44l24-10 24 10v24l-24 10-24-10z" />
		<path d="M36 44l24 10 24-10M60 54v24" />
		<path class="accent" d="M60 10q1.5 6.5 8 8q-6.5 1.5-8 8q-1.5-6.5-8-8q6.5-1.5 8-8z" />
	{/if}
</svg>

<style>
	.art {
		display: block;
		width: 120px;
		height: 88px;
		color: var(--ink);
	}
	.ground {
		fill: var(--idle);
		stroke: none;
	}
	.paper {
		fill: var(--surface);
	}
	.accent {
		fill: color-mix(in srgb, var(--sun) 70%, var(--surface));
	}
	.dot {
		fill: currentColor;
		stroke: none;
	}
</style>
