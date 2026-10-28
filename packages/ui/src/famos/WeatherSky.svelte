<script lang="ts">
	import { MediaQuery } from 'svelte/reactivity';
	import { paintCss, SKY_FOG_OPACITY, skyClouds, skyCondition, skyWash } from './sky.js';

	/**
	 * The weather as a sky: atmosphere behind the temperature, never the information
	 * itself. Each sky has its own wash of theme tokens (sky.ts, contrast-tested for text in every
	 * pack): the sun or the moon and stars, clouds (`sky-cloud`), low fog banks, fine drizzle,
	 * slanted rain, snow of mixed sizes (`sky-flake`) or a storm's flash. Motion is CSS keyframes
	 * on `transform` and `opacity` only, on at most eleven animated elements (rain and snow are
	 * repeating gradients, three layers with different tiles so no grid shows), so a Raspberry Pi
	 * keeps up. It stands still with `prefers-reduced-motion` and with `still`: the same picture,
	 * no motion.
	 *
	 * `block` fills a weather block (the parent is `position: relative`, the sky sits behind its
	 * content); `screen` fills ambient mode, with larger clouds and the sun away from the edge.
	 */
	let {
		code,
		isDay,
		size = 'block',
		still = false,
	}: { code: number; isDay: boolean; size?: 'block' | 'screen'; still?: boolean } = $props();

	const reduced = new MediaQuery('(prefers-reduced-motion: reduce)', false);
	const frozen = $derived(still || reduced.current);
	const condition = $derived(skyCondition(code, isDay));
	const wash = $derived(skyWash(condition));
	const clouds = $derived(skyClouds(condition));
	const kind = $derived(condition.kind);
	const night = $derived(condition.night);
	const screen = $derived(size === 'screen');

	/** Where the clouds float: left and top (%), height (in `--u`), strength factor. */
	const CLOUDS = [
		{ left: 58, top: 8, h: 1.9, o: 1 },
		{ left: 22, top: 40, h: 1.5, o: 0.75 },
		{ left: 74, top: 72, h: 2.3, o: 0.9 },
		{ left: 40, top: 70, h: 1.7, o: 0.7 },
		{ left: 4, top: 14, h: 2.1, o: 0.85 },
	] as const;
	const cloudCount = $derived(clouds.count === 0 ? 0 : clouds.count + (screen ? 2 : 0));
	const raining = $derived(kind === 'rain' || kind === 'storm' || kind === 'drizzle');
	const style = $derived(
		[
			`--top: ${paintCss(wash.top)}`,
			`--bottom: ${paintCss(wash.bottom)}`,
			`--cloud-opacity: ${clouds.opacity}`,
			`--fog-opacity: ${SKY_FOG_OPACITY}`,
		].join(';'),
	);
</script>

<div
	class="sky {size}"
	class:night
	data-testid="weather-sky"
	data-sky={kind}
	data-night={night}
	data-still={frozen}
	aria-hidden="true"
	{style}
>
	<div class="wash"></div>

	{#if kind === 'clear' || kind === 'partly'}
		{#if night}
			<span class="stars m"></span>
			<span class="stars late m"></span>
			<span class="moon"></span>
		{:else}
			<span class="halo m"></span>
			<span class="sun"></span>
		{/if}
	{/if}

	{#if kind === 'fog'}
		{#each [0, 1, 2, 3] as i (i)}
			<span
				class="bank m"
				style="top: {34 + i * 17}%; animation-delay: -{i * 7}s; animation-duration: {22 + i * 6}s"
			></span>
		{/each}
	{/if}

	{#each CLOUDS.slice(0, cloudCount) as c, i (i)}
		<span
			class="cloud m"
			style="left: {c.left}%; top: {c.top}%; --h: {c.h}; --o: {c.o}; animation-duration: {38 +
				i * 11}s; animation-delay: -{i * 13}s"
		></span>
	{/each}

	{#if raining}
		<span class="rain far m" class:fine={kind === 'drizzle'}></span>
		<span class="rain mid m" class:fine={kind === 'drizzle'}></span>
		{#if kind !== 'drizzle'}<span class="rain near m"></span>{/if}
	{/if}

	{#if kind === 'snow'}
		<span class="snow far m"></span>
		<span class="snow mid m"></span>
		<span class="snow near m"></span>
	{/if}

	{#if kind === 'storm'}
		<span class="flash m"></span>
	{/if}
</div>

<style>
	.sky {
		position: absolute;
		inset: 0;
		z-index: -1;
		overflow: hidden;
		pointer-events: none;
		--drop: color-mix(in srgb, var(--info) 80%, transparent);
		--u: 1rem;
		--sr: 1px;
	}
	.screen {
		--u: clamp(2.6rem, 6vmin, 5rem);
		--sr: 1.8px;
	}
	.sky > * {
		position: absolute;
		display: block;
	}
	/* The colours are theme tokens mixed in srgb (sky.ts), exactly as the contrast test computes. */
	.wash {
		inset: 0;
		background: linear-gradient(to bottom, var(--top), var(--bottom));
	}

	/* ── The sun: a disc with a breathing halo, in the corner of a block, in the sky on a screen. */
	.sun,
	.halo {
		border-radius: 50%;
		aspect-ratio: 1;
	}
	.sun {
		width: 4.5rem;
		top: -1.6rem;
		right: -1.2rem;
		background: var(--sun);
		opacity: 0.9;
	}
	.halo {
		width: 11rem;
		top: -4.85rem;
		right: -4.45rem;
		background: radial-gradient(
			closest-side,
			color-mix(in srgb, var(--sun) 60%, transparent),
			transparent
		);
		animation: breathe 9s ease-in-out infinite alternate;
	}
	.screen .sun {
		width: clamp(6rem, 14vmin, 12rem);
		top: 10%;
		right: 10%;
	}
	.screen .halo {
		width: clamp(16rem, 38vmin, 32rem);
		top: calc(10% + clamp(6rem, 14vmin, 12rem) / 2 - clamp(16rem, 38vmin, 32rem) / 2);
		right: calc(10% + clamp(6rem, 14vmin, 12rem) / 2 - clamp(16rem, 38vmin, 32rem) / 2);
	}

	/* ── The moon: a pale disc with a round bite taken out by a mask; stars twinkle in two sets. */
	.moon {
		width: 3rem;
		aspect-ratio: 1;
		top: 0.6rem;
		right: 0.9rem;
		border-radius: 50%;
		background: color-mix(in srgb, var(--sun) 45%, var(--sky-flake));
		mask-image: radial-gradient(circle at 70% 36%, transparent 47%, var(--ink) 48%);
		opacity: 0.9;
	}
	.screen .moon {
		width: clamp(5rem, 12vmin, 10rem);
		top: 10%;
		right: 10%;
	}
	.stars {
		inset: 0 0 35% 0;
		opacity: 0.8;
		background-image:
			radial-gradient(circle calc(var(--sr) * 1.2) at 12px 18px, var(--sky-flake) 90%, transparent),
			radial-gradient(circle var(--sr) at 61px 47px, var(--sky-flake) 90%, transparent),
			radial-gradient(circle calc(var(--sr) * 1.4) at 97px 9px, var(--sky-flake) 90%, transparent);
		background-size:
			131px 71px,
			173px 89px,
			211px 113px;
		animation: twinkle 5s ease-in-out infinite alternate;
	}
	.stars.late {
		background-position:
			70px 30px,
			20px 60px,
			140px 50px;
		animation-duration: 7s;
		animation-delay: -3s;
	}
	.screen .stars {
		background-size:
			181px 97px,
			233px 127px,
			307px 151px;
	}

	/*
	 * ── Clouds: one element in `sky-cloud`, shaped by a mask of a wide base and two puffs (mask
	 * layers add up, so where they overlap the cloud is not drawn twice), floating to and fro.
	 */
	.cloud {
		height: calc(var(--h) * var(--u) * 1.3);
		aspect-ratio: 2;
		background: var(--sky-cloud);
		mask-image:
			radial-gradient(closest-side, var(--ink) 96%, transparent),
			radial-gradient(closest-side, var(--ink) 96%, transparent),
			radial-gradient(closest-side, var(--ink) 96%, transparent);
		mask-size:
			100% 56%,
			50% 100%,
			36% 72%;
		mask-position:
			0 100%,
			30% 0,
			72% 70%;
		mask-repeat: no-repeat;
		opacity: calc(var(--cloud-opacity) * var(--o));
		animation: float 40s ease-in-out infinite alternate;
	}

	/* ── Fog: low, wide, soft bands drifting slowly sideways. */
	.bank {
		left: -30%;
		right: -30%;
		height: 18%;
		background: radial-gradient(closest-side, var(--sky-cloud), transparent);
		opacity: var(--fog-opacity);
		animation: sway 26s ease-in-out infinite alternate;
	}

	/*
	 * ── Rain and snow: three layers, each a pattern that repeats every tile height and is moved
	 * down by exactly one tile, so the loop never jumps. The layers have different tiles, sizes
	 * and offsets, so together they never line up in a grid. Rain is tilted.
	 */
	.rain {
		--tile: 150px;
		top: calc(var(--tile) * -1 - 40%);
		bottom: -40%;
		left: -30%;
		right: -30%;
		--len: 10px;
		--w: 1px;
		background-image:
			radial-gradient(var(--w) var(--len) at 8px 20px, var(--drop) 60%, transparent),
			radial-gradient(var(--w) calc(var(--len) * 1.2) at 30px 95px, var(--drop) 60%, transparent),
			radial-gradient(var(--w) calc(var(--len) * 0.8) at 17px 132px, var(--drop) 60%, transparent);
		background-size:
			43px var(--tile),
			61px var(--tile),
			79px var(--tile);
		opacity: 0.85;
		--tilt: 12deg;
		transform: rotate(var(--tilt));
		animation: fall 0.65s linear infinite;
	}
	.rain.mid {
		--tile: 190px;
		--tilt: 15deg;
		opacity: 0.55;
		background-size:
			53px var(--tile),
			71px var(--tile),
			97px var(--tile);
		background-position:
			20px 31px,
			5px 77px,
			33px 140px;
		animation-duration: 0.85s;
	}
	.rain.far {
		--tile: 230px;
		--tilt: 9deg;
		--len: 7px;
		opacity: 0.35;
		background-size:
			37px var(--tile),
			67px var(--tile),
			89px var(--tile);
		background-position:
			11px 59px,
			29px 3px,
			2px 170px;
		animation-duration: 1.15s;
	}
	.rain.fine {
		--len: 5px;
		--w: 0.8px;
		opacity: 0.8;
		animation-duration: 1.5s;
	}
	.rain.fine.far {
		--len: 4px;
		opacity: 0.55;
		animation-duration: 2.1s;
	}
	/*
	 * Snow: each layer is one wide tile with five flakes of different sizes scattered in it, and
	 * the layers are tilted a little differently, so no rows or grid show.
	 */
	.snow {
		--tile: 160px;
		--wide: 151px;
		--r: 2.8px;
		--tilt: 5deg;
		top: calc(var(--tile) * -1 - 30%);
		bottom: -30%;
		left: -25%;
		right: -25%;
		background-image:
			radial-gradient(circle calc(var(--r) * 1) at 14px 22px, var(--sky-flake) 55%, transparent),
			radial-gradient(circle calc(var(--r) * 0.75) at 83px 61px, var(--sky-flake) 55%, transparent),
			radial-gradient(circle calc(var(--r) * 1.2) at 47px 118px, var(--sky-flake) 55%, transparent),
			radial-gradient(circle calc(var(--r) * 0.85) at 121px 9px, var(--sky-flake) 55%, transparent),
			radial-gradient(circle calc(var(--r) * 1) at 102px 147px, var(--sky-flake) 55%, transparent);
		background-size: var(--wide) var(--tile);
		opacity: 0.8;
		transform: rotate(var(--tilt));
		animation: snowfall 9s linear infinite;
	}
	.snow.mid {
		--tile: 210px;
		--wide: 127px;
		--r: 2px;
		--tilt: -7deg;
		opacity: 0.65;
		background-position: 41px 77px;
		animation-duration: 14s;
	}
	.snow.far {
		--tile: 270px;
		--wide: 103px;
		--r: 1.4px;
		--tilt: 10deg;
		opacity: 0.5;
		background-position: 67px 19px;
		animation-duration: 21s;
	}
	.screen .snow {
		--r: 5px;
		--wide: 233px;
	}
	.screen .snow.mid {
		--r: 3.5px;
		--wide: 197px;
	}
	.screen .snow.far {
		--r: 2.2px;
		--wide: 163px;
	}

	/* ── A storm's lightning: the sky lights up twice in quick succession every few seconds. */
	.flash {
		inset: 0;
		background: var(--sky-flake);
		opacity: 0;
		animation: flash 7s linear infinite;
	}

	@keyframes breathe {
		from {
			transform: scale(0.9);
			opacity: 0.75;
		}
		to {
			transform: scale(1.08);
			opacity: 1;
		}
	}
	@keyframes twinkle {
		from {
			opacity: 0.3;
		}
		to {
			opacity: 0.9;
		}
	}
	@keyframes float {
		from {
			transform: translateX(-1.5rem);
		}
		to {
			transform: translateX(1.5rem);
		}
	}
	.screen .cloud {
		animation-name: float-wide;
	}
	@keyframes float-wide {
		from {
			transform: translateX(-6vw);
		}
		to {
			transform: translateX(6vw);
		}
	}
	@keyframes sway {
		from {
			transform: translateX(-10%);
		}
		to {
			transform: translateX(10%);
		}
	}
	@keyframes fall {
		from {
			transform: rotate(var(--tilt)) translateY(0);
		}
		to {
			transform: rotate(var(--tilt)) translateY(var(--tile));
		}
	}
	@keyframes snowfall {
		0% {
			transform: rotate(var(--tilt)) translate(0, 0);
		}
		50% {
			transform: rotate(var(--tilt)) translate(10px, calc(var(--tile) / 2));
		}
		100% {
			transform: rotate(var(--tilt)) translate(0, var(--tile));
		}
	}
	@keyframes flash {
		0%,
		88%,
		93%,
		100% {
			opacity: 0;
		}
		89% {
			opacity: 0.5;
		}
		90.5% {
			opacity: 0.08;
		}
		91.5% {
			opacity: 0.4;
		}
	}

	/* Still: the same picture without motion (the storm keeps no flash, rain keeps its slant). */
	.sky[data-still='true'] .m {
		animation: none;
	}
	@media (prefers-reduced-motion: reduce) {
		.m {
			animation: none;
		}
	}
</style>
