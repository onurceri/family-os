<script lang="ts">
	import { Button } from '@famos/ui/button';
	import { Segmented, Sheet, SidePanel, wide } from '@famos/ui/famos';
	import type { Values } from '../contract/index.js';
	import Controls from './Controls.svelte';
	import { detailFor, levelRequest, type SwitchRequest } from './controls.js';
	import { useHomeAssistant } from './i18n.js';
	import { sayValue, TONE_CLASS } from './say.js';

	/**
	 * The sheet a row opens when it offers more than its own control: the row says on or off, the
	 * sheet says how much. A half sheet below 1024 px, a side panel above. The head names the thing,
	 * says what it reads and repeats the row's own switch; the body is one part per kind of detail
	 * (a fan's speed so far). A pick is sent at once, and the value reads "Switching…" until the
	 * state shows. With "Ask before switching" a pick only chooses: one filled button names what
	 * will happen and sends it.
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
	const { app, t } = useHomeAssistant();

	const detail = $derived(detailFor(item.entityId, item.value));
	const said = $derived(sayValue(app, t, item.value));
	/** The speed chosen but not yet asked for, when the item asks first. */
	let chosen = $state<number | null>(null);
	$effect(() => {
		if (!open) chosen = null;
	});

	function pick(level: number, speeds: number) {
		if (busy) return;
		if (item.confirm) {
			chosen = level;
			return;
		}
		onswitch(levelRequest(level, speeds));
	}
	function send(speeds: number) {
		const level = chosen;
		chosen = null;
		if (level !== null) onswitch(levelRequest(level, speeds));
	}

	const select =
		'border-line bg-wall text-ink focus-visible:border-info focus-visible:ring-info/25 h-[var(--ctl)] w-full rounded-[var(--r-ctl)] border px-3 text-[0.9375rem] outline-none focus-visible:ring-3 disabled:opacity-60';
</script>

{#snippet body()}
	<div class="grid gap-5" data-testid="ha-thing-sheet">
		<div class="flex min-h-11 items-center gap-3">
			<span
				class="min-w-0 flex-1 text-[0.9375rem] font-semibold {busy
					? 'text-ink-soft'
					: TONE_CLASS[said.tone]}"
				aria-live="polite">{busy ? t('switching') : said.text}</span
			>
			<Controls {item} {busy} {onswitch} />
		</div>
		{#if detail}
			{@const current = chosen ?? detail.current ?? 0}
			<div class="grid gap-2">
				{#if detail.speeds <= 4}
					<Segmented
						label={t('speed_label')}
						grow
						value={current > 0 ? String(current) : ''}
						options={Array.from({ length: detail.speeds }, (_, i) => ({
							value: String(i + 1),
							label: String(i + 1),
							disabled: busy,
						}))}
						onchange={(value) => pick(Number(value), detail.speeds)}
					/>
				{:else}
					<select
						aria-label={t('speed_label')}
						class={select}
						disabled={busy}
						value={current > 0 ? String(current) : ''}
						onchange={(e) => {
							const level = Number(e.currentTarget.value);
							if (level > 0) pick(level, detail.speeds);
						}}
					>
						{#if current === 0}<option value="" disabled>{t('speed_label')}</option>{/if}
						{#each Array.from({ length: detail.speeds }, (_, i) => i + 1) as level (level)}
							<option value={String(level)}>{t('speed_level', { level })}</option>
						{/each}
					</select>
				{/if}
				{#if chosen !== null && chosen !== detail.current}
					<Button
						variant="primary"
						disabled={busy}
						onclick={() => send(detail.speeds)}
						data-testid="ha-speed-confirm"
						>{t('speed_set', { name: item.label, level: chosen })}</Button
					>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

{#if wide.current}
	<SidePanel {open} title={item.label} closeLabel={t('close')} {onclose}>
		{@render body()}
		{#snippet footer()}
			<Button variant="ghost" onclick={onclose}>{t('sheet_done')}</Button>
		{/snippet}
	</SidePanel>
{:else}
	<Sheet {open} half title={item.label} cancelLabel={t('sheet_done')} {onclose}>
		{@render body()}
	</Sheet>
{/if}
