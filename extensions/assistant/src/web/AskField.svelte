<script lang="ts">
	import { LimitCounter, lengthState } from '@famos/ui/famos';
	import { ArrowUp } from '@lucide/svelte';
	import { useAssistant } from './i18n.js';

	/**
	 * The message box: one rounded field that grows with the text up to about six lines, and the
	 * round send button inside it at the end (accent when there is something to send, quiet when
	 * empty). Enter sends with a keyboard; on a touch screen Enter is a new line and the button
	 * sends. Shift+Enter is always a new line.
	 */
	let {
		value = $bindable(''),
		field = $bindable(),
		disabled = false,
		busy = false,
		onsend,
	}: {
		value?: string;
		field?: HTMLTextAreaElement | undefined;
		/** The assistant is answering: nothing can be typed until it is done. */
		disabled?: boolean;
		/** A message is on its way. */
		busy?: boolean;
		onsend: () => void;
	} = $props();
	const { app, t } = useAssistant();
	const MAX = 4000;
	const over = $derived(lengthState(value, MAX).over);
	const ready = $derived(value.trim().length > 0 && !disabled && !busy && !over);
	const coarse = () => matchMedia('(pointer: coarse)').matches;

	function onkeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter' || event.shiftKey || event.isComposing || coarse()) return;
		event.preventDefault();
		if (ready) onsend();
	}
</script>

<form
	class="field"
	onsubmit={(event) => {
		event.preventDefault();
		if (ready) onsend();
	}}
>
	<label for="assistant-text" class="sr-only">{t('compose_label')}</label>
	<textarea
		id="assistant-text"
		bind:this={field}
		bind:value
		{onkeydown}
		rows={1}
		{disabled}
		placeholder={t('compose_placeholder')}></textarea>
	<button type="submit" class="send" class:ready aria-label={t('send')} disabled={!ready}>
		<ArrowUp aria-hidden="true" />
	</button>
</form>
<LimitCounter text={value} max={MAX} tooLong={(counter) => app.t('app:too_long', { counter })} />

<style>
	.field {
		display: flex;
		align-items: flex-end;
		gap: 8px;
		padding: 8px 8px 8px 20px;
		background: var(--surface);
		border-radius: 24px;
		box-shadow:
			var(--shadow-lit),
			0 6px 24px color-mix(in oklab, var(--ink) 8%, transparent),
			inset 0 0 0 1px var(--line);
		transition: box-shadow 150ms ease-out;
	}
	.field:focus-within {
		box-shadow:
			var(--shadow-lit),
			0 6px 24px color-mix(in oklab, var(--ink) 10%, transparent),
			inset 0 0 0 1.5px color-mix(in oklab, var(--ink) 40%, var(--line));
	}
	textarea {
		flex: 1;
		min-width: 0;
		min-height: 40px;
		/* About six lines; then it scrolls. */
		max-height: calc(6 * 1.5em + 16px);
		padding: 8px 0;
		border: 0;
		background: transparent;
		color: var(--ink);
		font: inherit;
		font-size: 16px;
		line-height: 1.5;
		resize: none;
		outline: none;
		field-sizing: content;
	}
	textarea::placeholder {
		color: var(--ink-soft);
	}
	textarea:disabled {
		cursor: progress;
	}
	.send {
		display: grid;
		flex: none;
		place-items: center;
		width: 40px;
		height: 40px;
		padding: 0;
		border: 0;
		border-radius: 999px;
		background: var(--idle);
		color: color-mix(in oklab, var(--ink-soft) 70%, var(--idle));
		cursor: default;
		outline: none;
		transition:
			background-color 150ms ease-out,
			color 150ms ease-out;
	}
	.send :global(svg) {
		width: 20px;
		height: 20px;
		stroke-width: 2.5;
	}
	.send.ready {
		background: var(--accent);
		color: var(--on-accent);
		cursor: pointer;
	}
	.send.ready:hover {
		background: color-mix(in oklab, var(--accent) 88%, var(--ink));
	}
	.send:focus-visible {
		box-shadow:
			0 0 0 2px var(--surface),
			0 0 0 4px var(--info);
	}
	@media (prefers-reduced-motion: reduce) {
		.field,
		.send {
			transition: none;
		}
	}
</style>
