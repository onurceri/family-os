<script lang="ts">
	import { Button } from '@famos/ui/button';
	import { Dialog } from '@famos/ui/famos';
	import type { Values } from '../contract/index.js';
	import { answerKey, askKey, controlsFor, type SwitchRequest } from './controls.js';
	import { useHomeAssistant } from './i18n.js';
	import Switch from './Switch.svelte';

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
		onswitch: (request: SwitchRequest) => void;
	} = $props();
	const { t } = useHomeAssistant();

	const controls = $derived(controlsFor(item.entityId, item.value));
	let asking = $state<SwitchRequest | null>(null);

	function press(request: SwitchRequest) {
		if (busy) return;
		if (item.confirm) asking = request;
		else onswitch(request);
	}
	function answer() {
		const request = asking;
		asking = null;
		if (request) onswitch(request);
	}
	/** The words of a request that is a plain operation (a speed has its own sheet). */
	const plain = (request: SwitchRequest) =>
		request.operation === 'set_percentage' ? null : request.operation;
	const asked = $derived(asking ? plain(asking) : null);
</script>

{#each controls as control (control.operation)}
	{#if control.kind === 'switch'}
		<Switch
			on={control.on}
			label={item.label}
			disabled={busy}
			onclick={() => press({ operation: control.operation })}
			testid="ha-switch-{item.id}"
		/>
	{:else}
		<Button
			variant="outline"
			size="sm"
			disabled={busy}
			onclick={() => press({ operation: control.operation })}
			aria-label={`${t(control.label)} · ${item.label}`}>{t(control.label)}</Button
		>
	{/if}
{/each}

<Dialog
	open={asked !== null}
	title={asked ? t(askKey(item.entityId, asked), { name: item.label }) : ''}
	description={t('ask_hint')}
	onclose={() => (asking = null)}
>
	{#snippet actions()}
		<Button variant="ghost" data-autofocus onclick={() => (asking = null)}>{t('cancel')}</Button>
		<Button variant="primary" onclick={answer}
			>{asked ? t(answerKey(item.entityId, asked)) : ''}</Button
		>
	{/snippet}
</Dialog>
