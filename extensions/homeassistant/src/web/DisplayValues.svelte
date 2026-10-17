<script lang="ts">
	import { DisplayRow, DisplaySection } from '@famos/ui/famos';
	import { House } from '@lucide/svelte';
	import type { Values } from '../contract/index.js';
	import { loadValues } from './data.js';
	import { useHomeAssistant } from './i18n.js';
	import { sayValue, TONE_CLASS } from './say.js';

	/**
	 * Family display widget: the sensors the family chose to show from Home Assistant, label and
	 * value, in larger type. Never a switch or a button: a display switches nothing. Nothing at all
	 * when there is nothing to show.
	 */
	let { rows }: { rows?: number } = $props();
	const { app, t } = useHomeAssistant();

	let values = $state<Values | null>(null);
	async function load() {
		try {
			values = await loadValues();
		} catch {
			// Keep what is on screen; the next refresh tries again.
		}
	}
	const shown = $derived(values?.status === 'ok' ? values.items : []);
	/** Every item the family chose, unless the display has room for fewer. */
	const max = $derived(Math.max(1, rows ?? shown.length));

	$effect(() => {
		void load();
		const refresh = setInterval(() => void load(), 60_000);
		const off = app.onEvent('homeassistant.', () => void load());
		return () => {
			clearInterval(refresh);
			off();
		};
	});
</script>

{#if shown.length > 0}
	<DisplaySection title={t('display_title')}>
		{#snippet icon()}<House class="text-now" />{/snippet}
		<div class="grid gap-2">
			{#each shown.slice(0, max) as item (item.id)}
				{@const said = sayValue(app, t, item.value)}
				<DisplayRow variant="lit" title={item.label}>
					{#snippet trail()}
						<span class="text-[17px] font-bold {TONE_CLASS[said.tone]}">{said.text}</span>
					{/snippet}
				</DisplayRow>
			{/each}
		</div>
		{#if shown.length > max}<p class="text-ink-soft px-1 text-[13px]">+{shown.length - max}</p>{/if}
	</DisplaySection>
{/if}
