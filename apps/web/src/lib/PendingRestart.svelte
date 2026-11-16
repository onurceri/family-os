<script lang="ts">
	import { RotateCcw } from '@lucide/svelte';
	import { Button } from '@famos/ui/button';
	import { t } from '#lib/i18n.svelte.js';
	import { pendingRestart } from '#lib/pending-restart.svelte.js';

	let { show }: { show: boolean } = $props();
</script>

{#if show}
	<div
		class="bg-idle text-ink-soft mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-1 text-sm font-semibold"
		role="status"
		data-testid="pending-restart"
	>
		<RotateCcw class="size-4 shrink-0" aria-hidden="true" />
		<span class="min-w-0 flex-1"
			>{t('restart_waiting', { count: Math.max(1, pendingRestart.count) })}</span
		>
		<Button variant="ghost" size="sm" href="/settings/extensions?restart=1">
			{t('extensions_restart')}
		</Button>
	</div>
{/if}
