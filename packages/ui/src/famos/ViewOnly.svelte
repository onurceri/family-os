<script lang="ts">
	import { findApp } from '../app-context.js';
	import Pill from './Pill.svelte';
	import { viewOnlyLine } from './view-only.js';

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
</script>

<svelte:window
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
		onclick={() => (open = !open)}
		class="focus-visible:ring-ring rounded-full outline-none focus-visible:ring-2"
		><Pill>{shown}</Pill></button
	>
	<span
		{id}
		aria-live="polite"
		data-testid="view-only-why"
		class={open
			? 'bg-surface text-ink shadow-lit absolute end-0 top-full z-40 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border p-3 text-sm leading-relaxed font-normal'
			: 'sr-only'}>{line}</span
	>
</span>
