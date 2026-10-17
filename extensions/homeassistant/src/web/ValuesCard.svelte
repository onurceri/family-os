<script lang="ts">
	import { TodayRow, TodaySection } from '@famos/ui/famos';
	import type { SlotProps } from '@famos/ui/slots';
	import type { Values } from '../contract/index.js';
	import Controls from './Controls.svelte';
	import { loadValues } from './data.js';
	import { useHomeAssistant } from './i18n.js';
	import { sayValue, TONE_CLASS } from './say.js';
	import { createSwitcher } from './switching.svelte.js';

	/**
	 * Today, notes band: the sensors the family chose to show from Home Assistant, one row each,
	 * label and value. Values are read about every minute. When Home Assistant cannot be asked, or
	 * nothing is picked, the card says nothing: Today never shows an error for it. Someone who may
	 * switch things finds a switch or buttons on the rows the family allowed switching.
	 */
	let { size, report }: SlotProps['dashboard.card'] = $props();
	const { app, t } = useHomeAssistant();
	const allowed = $derived(app.can('homeassistant.view'));
	const maySwitch = $derived(app.can('homeassistant.control'));

	let values = $state<Values | null>(null);
	let loaded = $state(false);
	async function load(): Promise<Values | null> {
		try {
			values = await loadValues();
		} catch {
			values = null;
		} finally {
			loaded = true;
		}
		return values;
	}
	const shown = $derived(values?.status === 'ok' ? values.items : []);
	const switcher = createSwitcher({ app, t, reload: load, shown: () => shown });

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
	$effect(() => () => switcher.stop());
</script>

{#if allowed && size !== 'line' && shown.length > 0}
	<TodaySection title={t('card_title')} count={String(shown.length)}>
		<div class="grid gap-2" data-testid="homeassistant-card">
			{#each shown as item (item.id)}
				{@const said = sayValue(app, t, item.value)}
				{@const busy = switcher.busy(item.id)}
				<TodayRow title={item.label}>
					{#snippet trailing()}
						<span
							class="text-[15px] font-semibold {busy ? 'text-ink-soft' : TONE_CLASS[said.tone]}"
							aria-live="polite">{busy ? t('switching') : said.text}</span
						>
						{#if maySwitch && item.control}
							<Controls {item} {busy} onswitch={(op) => void switcher.run(item, op)} />
						{/if}
					{/snippet}
				</TodayRow>
			{/each}
		</div>
	</TodaySection>
{/if}
