<script lang="ts">
	/**
	 * Bottom notice with an optional action ("Added to calendar · Undo"). The app owns the queue;
	 * this only renders the current message. Stays above the phone tab bar, and on phones also
	 * above a floating add button (`--fab-clearance`) and the preview bar (`--preview-bar-height`),
	 * which set those root properties while shown. Desktop keeps `md:bottom-6`.
	 */
	let {
		message,
		actionLabel,
		onaction,
		onhold,
		onrelease,
	}: {
		message: string;
		actionLabel?: string;
		onaction?: () => void;
		/** The pointer or focus is on the notice: the app keeps it on screen. */
		onhold?: () => void;
		/** The pointer and focus have left it. */
		onrelease?: () => void;
	} = $props();
</script>

<div
	role="status"
	onmouseenter={onhold}
	onmouseleave={onrelease}
	onfocusin={onhold}
	onfocusout={onrelease}
	class="bg-ink text-wall fixed inset-x-0 bottom-[calc(5.5rem+env(safe-area-inset-bottom)+max(var(--fab-clearance,0px),var(--preview-bar-height,0px)_-_12px))] z-50 mx-auto flex w-fit max-w-[calc(100%-2rem)] items-center gap-3 rounded-full px-4 py-2.5 text-sm font-semibold shadow-lg md:bottom-6"
>
	<span>{message}</span>
	{#if actionLabel && onaction}
		<button type="button" class="text-wall font-bold underline" onclick={onaction}
			>{actionLabel}</button
		>
	{/if}
</div>
