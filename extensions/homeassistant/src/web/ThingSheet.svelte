<script lang="ts">
	import { Sheet, SidePanel, wide } from '@famos/ui/famos';
	import type { Values } from '../contract/index.js';
	import {
		controlsFor,
		type Detail,
		detailKey,
		detailsFor,
		pickRequest,
		type Staged,
		type SwitchRequest,
		stagedRequests,
	} from './controls.js';
	import { useHomeAssistant } from './i18n.js';
	import LevelSlider from './LevelSlider.svelte';
	import LevelTiles from './LevelTiles.svelte';
	import Switch from './Switch.svelte';
	import { numberWords, optionWords } from './words.js';

	/**
	 * The sheet a row opens when it offers more than its own control: a small form of labelled
	 * groups. Power where the thing has on and off, then how much (a fan's speed, a brightness, a
	 * position, a target humidity, a volume), then what kind (a mode, a preset). A half sheet below
	 * 1024 px, a side panel above. A pick is sent at once and Done closes. With "Ask before
	 * switching" a pick and the switch only stage what the sheet shows, and Set sends it.
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
		/** One request per thing changed, in the order to send them. */
		onswitch: (requests: SwitchRequest[]) => void;
	} = $props();
	const { app, t } = useHomeAssistant();

	/** More options than this are chosen from a list instead of tiles. */
	const MAX_TILES = 6;

	const details = $derived(detailsFor(item.entityId, item.value));
	const on = $derived(item.value.kind === 'binary' && item.value.on);
	const switchControl = $derived(
		controlsFor(item.entityId, item.value).find((c) => c.kind === 'switch'),
	);
	/** What was staged but not yet asked for, when the item asks first (absent: not touched). */
	let stagedPower = $state<boolean | null>(null);
	let staged = $state<Staged>({});
	$effect(() => {
		if (!open) {
			stagedPower = null;
			staged = {};
		}
	});

	const asking = $derived(item.confirm);
	/** A brightness or a speed picked turns the thing on. */
	const impliesOn = $derived(staged.speed !== undefined || staged.brightness !== undefined);
	const shownOn = $derived(stagedPower ?? (impliesOn || on));

	function togglePower() {
		if (busy || !switchControl) return;
		if (asking) stagedPower = !shownOn;
		else onswitch([{ operation: switchControl.operation }]);
	}
	function pick(detail: Detail, picked: number | string) {
		if (busy) return;
		if (!asking) return onswitch([pickRequest(detail, picked)]);
		staged = { ...staged, [detailKey(detail)]: picked };
		if (detail.kind === 'speed' || (detail.kind === 'level' && detail.field === 'brightness'))
			stagedPower = true;
	}
	function send() {
		const requests = stagedRequests({ on, power: stagedPower, details, staged });
		if (requests.length > 0) onswitch(requests);
		onclose();
	}

	const percent = (n: number) => t('value_percent', { value: numberWords(n, app.formatLocale()) });
	const word = (option: string) => optionWords(option, (key) => t(key));
	const levelLabel = (field: 'brightness' | 'position' | 'humidity' | 'volume') =>
		t(`${field}_label`);
	/** What a group shows now: what was staged, else what the thing reads. */
	const shownNumber = (detail: Detail & { kind: 'level' }) => {
		const picked = staged[detail.field];
		return typeof picked === 'number' ? picked : detail.percent;
	};
	const shownOption = (detail: Detail & { kind: 'options' }) => {
		const picked = staged[detail.field];
		return typeof picked === 'string' ? picked : detail.current;
	};
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
		{#each details as detail (detailKey(detail))}
			{#if detail.kind === 'speed'}
				{@const picked = staged.speed}
				<div class="grid gap-2">
					<span class="text-[0.875rem] font-semibold">{t('speed_label')}</span>
					<LevelTiles
						count={detail.speeds}
						value={shownOn ? (typeof picked === 'number' ? picked : (detail.current ?? 0)) : 0}
						label={t('speed_label')}
						tileLabel={(level) => t('speed_level', { level })}
						disabled={busy}
						onpick={(level) => pick(detail, level)}
					/>
				</div>
			{:else if detail.kind === 'level'}
				<LevelSlider
					label={levelLabel(detail.field)}
					value={shownNumber(detail)}
					min={detail.min}
					max={detail.max}
					step={detail.step}
					format={percent}
					emptyText={t('value_off')}
					minLabel={detail.field === 'position' ? t('value_closed') : undefined}
					maxLabel={detail.field === 'position' ? t('value_open') : undefined}
					switchingText={t('switching')}
					decreaseLabel={t('decrease')}
					increaseLabel={t('increase')}
					{busy}
					deferred={asking}
					disabled={busy}
					testid="ha-sheet-{detail.field}"
					onchoose={(n) => pick(detail, n)}
				/>
			{:else}
				{@const chosen = shownOption(detail)}
				{@const label = t(`${detail.field}_label`)}
				<div class="grid gap-2">
					<span class="text-[0.875rem] font-semibold">{label}</span>
					{#if detail.options.length <= MAX_TILES}
						<LevelTiles
							count={detail.options.length}
							value={chosen === null ? 0 : detail.options.indexOf(chosen) + 1}
							{label}
							labels={detail.options.map(word)}
							columns={Math.min(detail.options.length, 3)}
							tileLabel={(level) => word(detail.options[level - 1] ?? '')}
							disabled={busy}
							onpick={(level) => pick(detail, detail.options[level - 1] ?? '')}
						/>
					{:else}
						<select
							class="bg-idle text-ink focus-visible:ring-ink h-[var(--ctl)] w-full cursor-pointer rounded-[var(--r-ctl)] px-3 text-[0.9375rem] focus-visible:ring-2 focus-visible:outline-none disabled:opacity-45"
							aria-label={label}
							disabled={busy}
							value={chosen ?? ''}
							onchange={(e) => pick(detail, e.currentTarget.value)}
						>
							{#if chosen === null}<option value="" disabled></option>{/if}
							{#each detail.options as option (option)}
								<option value={option}>{word(option)}</option>
							{/each}
						</select>
					{/if}
				</div>
			{/if}
		{/each}
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
