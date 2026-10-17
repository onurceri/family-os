<script lang="ts">
	import { TodayRow, TodaySection } from '@famos/ui/famos';
	import type { SlotProps } from '@famos/ui/slots';
	import type { Values } from '../contract/index.js';
	import { loadValues } from './data.js';
	import { useHomeAssistant } from './i18n.js';
	import { sayValue, TONE_CLASS } from './say.js';

	/**
	 * Today, notes band: the sensors the family chose to show from Home Assistant, one row each,
	 * label and value. Values are read about every minute. When Home Assistant cannot be asked, or
	 * nothing is picked, the card says nothing: Today never shows an error for it.
	 */
	let { size, report }: SlotProps['dashboard.card'] = $props();
	const { app, t } = useHomeAssistant();
	const allowed = $derived(app.can('homeassistant.view'));

	let values = $state<Values | null>(null);
	let loaded = $state(false);
	async function load() {
		try {
			values = await loadValues();
		} catch {
			values = null;
		} finally {
			loaded = true;
		}
	}
	const shown = $derived(values?.status === 'ok' ? values.items : []);

	// Reports only once loaded: the page keeps the last report while a card moves between columns.
	$effect(() => {
		if (!allowed) report({ count: 0, quietKey: 'homeassistant:quiet_values' });
		else if (loaded) report({ count: shown.length, quietKey: 'homeassistant:quiet_values' });
	});

	$effect(() => {
		if (!allowed) return;
		void load();
		const refresh = setInterval(() => void load(), 60_000);
		const off = app.onEvent('homeassistant.', () => void load());
		return () => {
			clearInterval(refresh);
			off();
		};
	});
</script>

{#if allowed && size !== 'line' && shown.length > 0}
	<TodaySection title={t('card_title')} count={String(shown.length)}>
		<div class="grid gap-2" data-testid="homeassistant-card">
			{#each shown as item (item.id)}
				{@const said = sayValue(app, t, item.value)}
				<TodayRow title={item.label}>
					{#snippet trailing()}
						<span class="text-[15px] font-semibold {TONE_CLASS[said.tone]}">{said.text}</span>
					{/snippet}
				</TodayRow>
			{/each}
		</div>
	</TodaySection>
{/if}
