<script lang="ts">
	import { Sheet, SidePanel, wide } from '@famos/ui/famos';
	import type { Values } from '../contract/index.js';
	import {
		controlsFor,
		detailFor,
		levelRequest,
		stagedRequest,
		type SwitchRequest,
	} from './controls.js';
	import { useHomeAssistant } from './i18n.js';
	import LevelTiles from './LevelTiles.svelte';
	import Switch from './Switch.svelte';

	/**
	 * The sheet a row opens when it offers more than its own control: a small form of labelled
	 * groups, Power and then how much (a fan's speed so far). A half sheet below 1024 px, a side
	 * panel above. A pick is sent at once and Done closes. With "Ask before switching" a pick and
	 * the switch only stage what the sheet shows, and Set sends it.
	 */
	let {
		item,
		open,
		busy = false,
		onclose,
		onswitch,
	}: {
		item: Values['items'][number];
		open: boolean;
		busy?: boolean;
		onclose: () => void;
		onswitch: (request: SwitchRequest) => void;
	} = $props();
	const { t } = useHomeAssistant();

	const detail = $derived(detailFor(item.entityId, item.value));
	const on = $derived(item.value.kind === 'binary' && item.value.on);
	const switchControl = $derived(
		controlsFor(item.entityId, item.value).find((c) => c.kind === 'switch'),
	);
	/** What was staged but not yet asked for, when the item asks first (null: not touched). */
	let stagedPower = $state<boolean | null>(null);
	let stagedLevel = $state<number | null>(null);
	$effect(() => {
		if (!open) {
			stagedPower = null;
			stagedLevel = null;
		}
	});

	const shownOn = $derived(stagedPower ?? on);
	const shownLevel = $derived(stagedLevel ?? detail?.current ?? 0);

	function togglePower() {
		if (busy || !switchControl) return;
		if (item.confirm) stagedPower = !shownOn;
		else onswitch({ operation: switchControl.operation });
	}
	function pick(level: number, speeds: number) {
		if (busy) return;
		if (item.confirm) {
			stagedLevel = level;
			stagedPower = true;
		} else onswitch(levelRequest(level, speeds));
	}
	function send() {
		const request = stagedRequest({
			on,
			current: detail?.current ?? null,
			power: stagedPower,
			level: stagedLevel,
			speeds: detail?.speeds ?? 0,
		});
		if (request) onswitch(request);
		onclose();
	}
	const asking = $derived(item.confirm);
</script>

{#snippet body()}
	<div class="grid gap-5" data-testid="ha-thing-sheet">
		{#if switchControl}
			<div class="flex min-h-11 items-center justify-between gap-3">
				<span class="text-[0.875rem] font-semibold">{t('power_label')}</span>
				<Switch
					on={shownOn}
					label={t('power_label')}
					disabled={busy}
					onclick={togglePower}
					testid="ha-sheet-power"
				/>
			</div>
		{/if}
		{#if detail}
			<div class="grid gap-2">
				<span class="text-[0.875rem] font-semibold">{t('speed_label')}</span>
				<LevelTiles
					count={detail.speeds}
					value={shownOn ? shownLevel : 0}
					label={t('speed_label')}
					tileLabel={(level) => t('speed_level', { level })}
					disabled={busy}
					onpick={(level) => pick(level, detail.speeds)}
				/>
			</div>
		{/if}
		{#if asking}
			<p class="text-ink-soft text-[0.8125rem]">{t('ask_note')}</p>
		{/if}
	</div>
{/snippet}

{#if wide.current}
	<SidePanel
		{open}
		title={item.label}
		closeLabel={t('close')}
		cancelLabel={asking ? t('cancel') : undefined}
		saveLabel={asking ? t('set') : undefined}
		onsave={asking ? send : undefined}
		{onclose}
	>
		{@render body()}
	</SidePanel>
{:else}
	<Sheet
		{open}
		half
		title={item.label}
		cancelLabel={asking ? t('cancel') : undefined}
		saveLabel={asking ? t('set') : t('sheet_done')}
		onsave={asking ? send : onclose}
		{onclose}
	>
		{@render body()}
	</Sheet>
{/if}
