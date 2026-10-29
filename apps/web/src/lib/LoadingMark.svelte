<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '#lib/i18n.svelte.js';

	// Taking over from the shell's mark (app.html) while it is on screen: this one appears at
	// once, in the same place, so the spinner neither disappears nor waits another 800 ms.
	let handover = $state(false);
	onMount(() => {
		const boot = document.getElementById('boot-mark');
		if (!boot) return;
		handover = Number(getComputedStyle(boot).opacity) > 0;
		boot.remove();
	});
</script>

<!-- Quiet and late: invisible for the first 800 ms, so a fast load never flashes it. -->
<div class="mark" class:handover role="status" data-testid="loading-mark">
	<span class="ring" aria-hidden="true"></span>
	<span class="sr-only">{t('loading')}</span>
</div>

<style>
	.mark {
		position: fixed;
		inset: 0;
		display: grid;
		place-items: center;
		pointer-events: none;
		opacity: 0;
		animation: mark-in 240ms ease-out 800ms forwards;
	}
	.mark.handover {
		opacity: 1;
		animation: none;
	}
	.ring {
		width: 24px;
		height: 24px;
		border-radius: 50%;
		border: 2px solid var(--line);
		border-top-color: var(--ink-soft);
		animation: mark-spin 900ms linear infinite;
	}
	@keyframes mark-in {
		to {
			opacity: 1;
		}
	}
	@keyframes mark-spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.ring {
			animation: none;
		}
	}
</style>
