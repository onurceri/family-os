<script lang="ts">
	/**
	 * A progress ring: a `line` track and an arc in a member's colour (or `ink-soft`
	 * for anyone), with its value as text in the middle ("1/3"), so the number never lives only in
	 * the arc. With nothing to count (`total` 0) it is an empty ring: "0/0" would read as a score. `fraction` overrides `done / total` (the countdown ring); `name` gives the ring an
	 * accessible name of its own ("Elif: 1 of 3 chores done").
	 */
	let {
		done = 0,
		total = 0,
		fraction,
		text,
		color,
		size = 48,
		stroke = 5,
		name,
		dim = false,
		onAccent = false,
	}: {
		done?: number;
		total?: number;
		fraction?: number;
		/** The text in the middle; `done/total` by default, none when `total` is 0. */
		text?: string;
		/** A member's colour; the arc is `ink-soft` without one. */
		color?: string;
		size?: number;
		stroke?: number;
		name?: string;
		/** Receded: nothing to count. */
		dim?: boolean;
		/** Drawn on the accent surface (the hero's countdown): `on-accent` arc and text. */
		onAccent?: boolean;
	} = $props();

	const r = $derived((size - stroke) / 2);
	const c = $derived(2 * Math.PI * r);
	const part = $derived(Math.max(0, Math.min(1, fraction ?? (total > 0 ? done / total : 0))));
	const label = $derived(text ?? (total > 0 ? `${done}/${total}` : ''));
</script>

<span
	class="meter"
	class:dim
	class:on-accent={onAccent}
	style:width="{size}px"
	style:height="{size}px"
	style:--ring-color={color}
	role={name ? 'img' : undefined}
	aria-label={name}
	data-testid="ring"
>
	<svg viewBox="0 0 {size} {size}" aria-hidden="true">
		<circle class="track" cx={size / 2} cy={size / 2} {r} stroke-width={stroke} />
		{#if part > 0}<circle
				class="arc"
				cx={size / 2}
				cy={size / 2}
				{r}
				stroke-width={stroke}
				stroke-dasharray={c}
				stroke-dashoffset={c * (1 - part)}
			/>{/if}
	</svg>
	{#if label}<span class="value font-display" style:font-size="{Math.round(size * 0.33)}px"
			>{label}</span
		>{/if}
</span>

<style>
	.meter {
		position: relative;
		display: inline-grid;
		place-items: center;
		flex: none;
	}
	.dim {
		opacity: 0.4;
	}
	svg {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		transform: rotate(-90deg);
	}
	circle {
		fill: none;
	}
	.track {
		stroke: var(--line);
	}
	.arc {
		stroke: var(--ring-color, var(--ink-soft));
		stroke-linecap: round;
	}
	.on-accent .track {
		stroke: transparent;
		stroke: color-mix(in oklab, var(--on-accent) 20%, transparent);
	}
	.on-accent .arc {
		stroke: var(--on-accent);
	}
	.on-accent .value {
		color: var(--on-accent);
	}
	.value {
		position: relative;
		font-weight: 600;
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}
</style>
