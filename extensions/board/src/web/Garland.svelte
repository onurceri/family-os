<script lang="ts">
	/**
	 * A garland across the top of the board, for the look only: a string that sags between a few
	 * points, with paper flags by day and small lights by night. Three swags of four on a wide
	 * board, two of three on a phone (at most twelve things move). CSS animations only, and none
	 * for people who ask for less motion.
	 */
	type Hang = { left: number; top: number; i: number };

	/** The string's points: `swags` sags, `per` things on each, and where they hang (in px). */
	function garland(swags: number, per: number, anchor: number, sag: number) {
		const hangs: Hang[] = [];
		const width = 1000 / swags;
		let path = `M0 ${anchor}`;
		for (let s = 0; s < swags; s++) {
			// A quadratic curve with its control point in the middle sinks `sag` px at its lowest.
			path += ` Q${(s + 0.5) * width} ${anchor + sag * 2} ${(s + 1) * width} ${anchor}`;
			for (let k = 1; k <= per; k++) {
				const u = k / (per + 1);
				hangs.push({
					left: ((s + u) / swags) * 100,
					top: anchor + 2 * u * (1 - u) * sag * 2,
					i: s * per + k - 1,
				});
			}
		}
		return { path, hangs };
	}

	const wide = garland(3, 4, 3, 16);
	const narrow = garland(2, 3, 3, 11);
</script>

{#snippet strand(g: { path: string; hangs: Hang[] }, height: number, kind: 'wide' | 'narrow')}
	<div class="strand {kind}" style:height="{height}px">
		<svg class="string" viewBox="0 0 1000 {height}" preserveAspectRatio="none">
			<path d={g.path} vector-effect="non-scaling-stroke" />
		</svg>
		{#each g.hangs as hang (hang.i)}
			<span
				class="hang"
				style:left="{hang.left}%"
				style:top="{hang.top}px"
				style:--i={hang.i}
				style:--twinkle="{3 + (hang.i % 3) * 0.8}s"
				style:--paper="var(--note-{(hang.i % 5) + 1})"
			>
				<span class="flag"></span>
				<span class="bulb"></span>
			</span>
		{/each}
	</div>
{/snippet}

<div class="garland" aria-hidden="true">
	{@render strand(wide, 48, 'wide')}
	{@render strand(narrow, 36, 'narrow')}
</div>

<style>
	.garland {
		position: absolute;
		inset: 0 0 auto;
		pointer-events: none;
	}
	.strand {
		position: relative;
	}
	.wide {
		display: none;
	}
	@container cork (width >= 560px) {
		.wide {
			display: block;
		}
		.narrow {
			display: none;
		}
	}
	.string {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		overflow: visible;
	}
	.string path {
		fill: none;
		stroke: var(--ink-soft);
		stroke: color-mix(in srgb, var(--ink-soft) 70%, transparent);
		stroke-width: 1.25px;
	}
	.hang {
		position: absolute;
		width: 0;
		height: 0;
	}
	/* By day: a small paper flag, swaying from the string. */
	.flag {
		position: absolute;
		top: -1px;
		left: -9px;
		width: 18px;
		height: 24px;
		background: var(--paper);
		clip-path: polygon(0 0, 100% 0, 50% 100%);
		transform-origin: 50% 0;
		filter: drop-shadow(0 1px 0 transparent);
		filter: drop-shadow(0 1px 0 color-mix(in srgb, var(--backdrop) 18%, transparent));
		animation: sway 3s ease-in-out calc(var(--i) * -0.55s) infinite alternate;
	}
	.narrow .flag {
		left: -7px;
		width: 14px;
		height: 19px;
	}
	/* By night: a small light, twinkling. */
	.bulb {
		display: none;
		position: absolute;
		top: 1px;
		left: -5px;
		width: 10px;
		height: 13px;
		border-radius: 50% 50% 50% 50% / 40% 40% 60% 60%;
		background: var(--sun);
		box-shadow:
			0 0 6px 2px var(--sun),
			0 0 16px 4px transparent;
		box-shadow:
			0 0 6px 2px color-mix(in srgb, var(--sun) 55%, transparent),
			0 0 16px 4px color-mix(in srgb, var(--sun) 22%, transparent);
		animation: twinkle var(--twinkle) ease-in-out calc(var(--i) * -0.7s) infinite alternate;
	}
	.bulb::before {
		content: '';
		position: absolute;
		top: -3px;
		left: 2px;
		width: 6px;
		height: 4px;
		border-radius: 1px;
		background: var(--ink-soft);
	}
	:global(.dark) .flag {
		display: none;
	}
	:global(.dark) .bulb {
		display: block;
	}
	@keyframes sway {
		from {
			transform: rotate(-2deg);
		}
		to {
			transform: rotate(2deg);
		}
	}
	@keyframes twinkle {
		from {
			opacity: 0.55;
		}
		to {
			opacity: 1;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.flag,
		.bulb {
			animation: none;
		}
	}
</style>
