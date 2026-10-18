<script lang="ts">
	import { findApp } from '../app-context.js';
	import Pill from './Pill.svelte';
	import { bubblePlace, viewOnlyLine } from './view-only.js';

	/**
	 * The quiet mark in a page's head when the page's main action is not for this viewer: the page
	 * can be read and nothing on it can be changed. Said once, by the head, and not by a disabled
	 * control (principle 5). A tap (or Enter) says why in one line under it, and whom to ask, so a
	 * touch screen reads it too; Escape or a tap elsewhere closes it.
	 */
	let { label }: { label?: string } = $props();
	const app = findApp();
	let open = $state(false);
	const id = `view-only-${Math.random().toString(36).slice(2, 9)}`;
	const shown = $derived(label ?? app?.t('app:view_only') ?? '');
	// The names are read only once someone asks why.
	const line = $derived(open && app ? viewOnlyLine(app.roleManagers(), app.me()?.id, app.t) : '');

	// The line is placed against the window, so a pill anywhere in a head keeps it on screen.
	let button = $state<HTMLButtonElement>();
	let place = $state<{ left: number; top: number; width: number } | null>(null);
	function measure() {
		if (!open || !button) return;
		const viewport = document.documentElement.clientWidth;
		const width = Math.min(288, viewport - 32);
		const rtl = getComputedStyle(button).direction === 'rtl';
		place = { ...bubblePlace(button.getBoundingClientRect(), width, viewport, rtl), width };
	}
	$effect(() => {
		if (open) measure();
		else place = null;
	});
</script>

<svelte:window
	onresize={measure}
	onscrollcapture={measure}
	onkeydown={(e) => {
		if (e.key === 'Escape') open = false;
	}}
	onpointerdown={(e) => {
		if (open && !(e.target as Element).closest(`[data-view-only="${id}"]`)) open = false;
	}}
/>

<span class="relative inline-flex" data-view-only={id} data-testid="view-only">
	<button
		type="button"
		aria-expanded={open}
		aria-controls={id}
		bind:this={button}
		onclick={() => (open = !open)}
		class="focus-visible:ring-ring rounded-full outline-none focus-visible:ring-2"
		><Pill>{shown}</Pill></button
	>
	<span
		{id}
		aria-live="polite"
		data-testid="view-only-why"
		style:left={place ? `${place.left}px` : undefined}
		style:top={place ? `${place.top}px` : undefined}
		style:width={place ? `${place.width}px` : undefined}
		class={open
			? 'bg-surface text-ink shadow-lit fixed z-40 rounded-xl border p-3 text-sm leading-relaxed font-normal'
			: 'sr-only'}>{line}</span
	>
</span>
