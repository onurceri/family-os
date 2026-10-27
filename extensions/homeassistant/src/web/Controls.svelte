<script lang="ts">
	import { Button } from '@famos/ui/button';
	import { Dialog } from '@famos/ui/famos';
	import type { Operation, Values } from '../contract/index.js';
	import { answerKey, askKey, controlsFor } from './controls.js';
	import { useHomeAssistant } from './i18n.js';

	/**
	 * The switch or the buttons of a row the family allowed switching, for someone who may. With
	 * "Ask before switching" a tap opens a sheet that names the thing and what will happen
	 * ("Unlock Front door?"). While a switch is on its way the controls wait.
	 */
	let {
		item,
		busy = false,
		onswitch,
	}: {
		item: Values['items'][number];
		busy?: boolean;
		onswitch: (operation: Operation) => void;
	} = $props();
	const { t } = useHomeAssistant();

	const controls = $derived(controlsFor(item.entityId, item.value));
	let asking = $state<Operation | null>(null);

	function press(operation: Operation) {
		if (busy) return;
		if (item.confirm) asking = operation;
		else onswitch(operation);
	}
	function answer() {
		const operation = asking;
		asking = null;
		if (operation) onswitch(operation);
	}
</script>

{#each controls as control (control.operation)}
	{#if control.kind === 'switch'}
		<button
			type="button"
			role="switch"
			aria-checked={control.on}
			aria-label={item.label}
			disabled={busy}
			onclick={() => press(control.operation)}
			class="group focus-visible:ring-ink -my-2 grid min-h-11 shrink-0 cursor-pointer place-items-center rounded-full px-1 focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
			data-testid="ha-switch-{item.id}"
		>
			<span
				aria-hidden="true"
				class="track-ink-soft/35 group-aria-checked:bg-now after:bg-surface after:shadow-lit relative h-7 w-12 rounded-full transition-colors after:absolute after:top-1 after:left-1 after:size-5 after:rounded-full after:transition-transform group-aria-checked:after:translate-x-5 motion-reduce:transition-none motion-reduce:after:transition-none"
			></span>
		</button>
	{:else}
		<Button
			variant="outline"
			size="sm"
			disabled={busy}
			onclick={() => press(control.operation)}
			aria-label={`${t(control.label)} · ${item.label}`}>{t(control.label)}</Button
		>
	{/if}
{/each}

<Dialog
	open={asking !== null}
	title={asking ? t(askKey(item.entityId, asking), { name: item.label }) : ''}
	description={t('ask_hint')}
	onclose={() => (asking = null)}
>
	{#snippet actions()}
		<Button variant="ghost" data-autofocus onclick={() => (asking = null)}>{t('cancel')}</Button>
		<Button variant="primary" onclick={answer}
			>{asking ? t(answerKey(item.entityId, asking)) : ''}</Button
		>
	{/snippet}
</Dialog>
