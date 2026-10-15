<script lang="ts">
	import { Button } from '@famos/ui/button';
	import { t } from '#lib/i18n.svelte.js';
	import { readBoot, waitForRestart } from '#lib/restart.js';

	/**
	 * Covers the app while the server restarts: nothing can be done meanwhile, and the page reloads
	 * by itself once the server answers from its new start, so it runs what was installed. `before`
	 * is the start id read before the restart was asked for.
	 */
	let { before }: { before: string | null } = $props();

	let slow = $state(false);

	$effect(() => {
		const left = new AbortController();
		void waitForRestart({
			before,
			read: () => readBoot(),
			sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
			now: () => Date.now(),
			signal: left.signal,
		}).then((result) => {
			if (result === 'restarted') location.reload();
			else if (result === 'timeout') slow = true;
		});
		return () => left.abort();
	});
</script>

<div class="cover" role="alertdialog" aria-modal="true" aria-labelledby="restarting-title">
	<div class="grid max-w-sm justify-items-center gap-3 px-6 text-center" aria-live="polite">
		{#if slow}
			<h2 id="restarting-title" class="text-[17px] font-bold">{t('extensions_restart_slow')}</h2>
			<p class="text-ink-soft text-sm">{t('extensions_restart_slow_hint')}</p>
			<Button variant="primary" onclick={() => location.reload()}>{t('extensions_reload')}</Button>
		{:else}
			<span class="ring" aria-hidden="true"></span>
			<h2 id="restarting-title" class="text-[17px] font-bold" data-testid="restarting">
				{t('extensions_restarting')}
			</h2>
			<p class="text-ink-soft text-sm">{t('extensions_restarting_hint')}</p>
		{/if}
	</div>
</div>

<style>
	.cover {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: grid;
		place-items: center;
		background: var(--wall);
	}
	.ring {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		border: 2px solid var(--line);
		border-top-color: var(--ink-soft);
		animation: spin 900ms linear infinite;
	}
	@keyframes spin {
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
