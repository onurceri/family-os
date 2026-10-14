<script lang="ts">
	import { type AppContext, provideAppContext, useApp } from '@famos/ui/app';
	import type { StyleId } from '@famos/ui/styles';
	import { MediaQuery } from 'svelte/reactivity';
	import { innerHeight, innerWidth } from 'svelte/reactivity/window';
	import { family } from '#lib/family.svelte.js';
	import { compositionFor } from './compositions.js';
	import { sampleDay } from './sample.js';
	import { TodayData } from './today-data.svelte.js';

	/**
	 * A style's Today as a picture (Settings → Appearance): the real composition with a
	 * made-up day (`sampleDay`), in the palette in use, drawn at the size Today has on this screen
	 * and scaled down to the width it is given. It is inert: nothing in it can be focused or
	 * clicked, nothing in it loads cards, and it is hidden from assistive technology (the page
	 * names the style beside it).
	 */
	let { style }: { style: StyleId } = $props();

	const real = useApp();
	/**
	 * The app for the picture: no capabilities, no place to share, no slots and no events, so nothing
	 * mounts or loads.
	 */
	const app: AppContext = Object.assign(Object.create(real) as AppContext, {
		can: () => false,
		share: () => undefined,
		slots: () => [],
		onEvent: () => () => {},
		toast: () => {},
	});
	provideAppContext(app);

	// The day is made in the family's time zone when the picture is made (the page keys it on it).
	const data = new TodayData(app, { sample: sampleDay(family.timeZone) });
	const Composition = $derived(compositionFor(style));

	/** Wide windows have the sidebar beside Today; the picture leaves it out. */
	const SIDEBAR = 248;
	const wide = new MediaQuery('(min-width: 1024px)', false);
	const frameWidth = $derived(
		Math.max(360, (innerWidth.current ?? 1440) - (wide.current ? SIDEBAR : 0)),
	);
	const frameHeight = $derived(
		wide.current
			? Math.round(Math.min(frameWidth * 0.68, Math.max(640, innerHeight.current ?? 900)))
			: 640,
	);
	let width = $state(0);
	const scale = $derived(width > 0 ? width / frameWidth : 0);
</script>

<div
	class="bg-wall relative overflow-hidden"
	bind:clientWidth={width}
	style:height="{Math.round(frameHeight * scale)}px"
	data-testid="style-preview-{style}"
>
	{#if scale > 0}
		<div
			class="frame absolute start-0 top-0 origin-top-left px-4 pt-6 lg:px-10 lg:pt-8"
			data-style={style}
			inert
			aria-hidden="true"
			style:width="{frameWidth}px"
			style:height="{frameHeight}px"
			style:transform="scale({scale})"
		>
			<Composition {data} />
		</div>
	{/if}
</div>

<style>
	.frame {
		overflow: hidden;
		pointer-events: none;
	}
	:global([dir='rtl']) .frame {
		transform-origin: top right;
	}
</style>
