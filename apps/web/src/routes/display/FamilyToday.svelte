<script lang="ts">
	import { useApp } from '@famos/ui/app';
	import type { StyleId } from '@famos/ui/styles';
	import { flushSync, type Snippet, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { compositionFor } from '#lib/today/compositions.js';
	import type { DisplayFit, FitDrop } from '#lib/today/display-fit.js';
	import {
		baseZoom,
		chooseFit,
		describeFit,
		type FitPlan,
		leftOut,
		widgetRows,
	} from '#lib/today/fit-plan.js';
	import { TodayData } from '#lib/today/today-data.svelte.js';

	/**
	 * The display's Today: the composition of the display's style in family mode, read
	 * as the display (its view capabilities, through routes a display may call). `status` (the
	 * display's pills) goes in the composition's head; `foot` (the `display.widget` band) where
	 * the composition has room for it. Made again when "show names" changes, so nothing loaded
	 * with names stays on a display without them.
	 *
	 * A wall display is never scrolled, so the whole page fits one screen, at any size. Once the
	 * composition has settled (and the widgets have stopped growing) it is measured, still hidden,
	 * against plans tried in order of priority until one fits (`fit-plan.ts`): what the display was
	 * given (its widgets, everyone's status with who is home) goes last, after the decoration,
	 * shorter widgets, the extras and a little less zoom. Once one fits, what the space now allows
	 * comes back. Every plan is applied and measured in the same task (`flushSync`), so nothing in
	 * between is ever painted; it is measured again whenever the page changes size (live updates,
	 * a rotated tablet). What it still had no room for is told through `onfit`.
	 */
	let {
		style,
		showNames,
		disabledExtensions,
		hidden,
		reloadKey,
		status,
		foot,
		onfit,
	}: {
		style: StyleId;
		showNames: boolean;
		disabledExtensions: () => readonly string[];
		/** The blocks this display's Today hides (its own choice, else the family's). */
		hidden: () => readonly string[];
		/** Bumped now and then: everything is read again (a live update may have been missed). */
		reloadKey: number;
		status?: Snippet;
		/**
		 * The widget band; `shown(i)` says whether its i-th widget is in the plan that fits, `rows()`
		 * the most rows each widget may show (none: its own limit).
		 */
		foot?: Snippet<[shown: (index: number) => boolean, rows: () => number | undefined]>;
		/** After each fit: what the screen had no room for (widget ids and groups of blocks). */
		onfit?: (leftOut: string[]) => void;
	} = $props();

	// `showNames` is fixed for this component's life: the page keys it.
	const data = new TodayData(useApp(), {
		familyMode: {
			showNames: untrack(() => showNames),
			disabledExtensions: () => disabledExtensions(),
		},
		hidden: () => hidden(),
	});
	const Composition = $derived(compositionFor(style));

	let lastKey = untrack(() => reloadKey);
	$effect(() => {
		if (reloadKey === lastKey) return;
		lastKey = reloadKey;
		untrack(() => data.reload());
	});

	/* ───────────── fitting one screen ───────────── */

	/** No change in size for this long and the widgets have loaded; never longer than the cap. */
	const QUIET_MS = 200;
	const QUIET_CAP_MS = 1500;

	let root = $state<HTMLDivElement>();
	let band = $state<HTMLDivElement>();
	let composed = $state(false);
	let hold = $state(true);
	let tight = $state(0);
	let rows = $state(0);
	const drop = new SvelteSet<FitDrop>();
	let hide = $state<readonly number[]>([]);
	let zoom = $state(baseZoom(typeof window === 'undefined' ? 0 : window.innerWidth));
	let shift = $state(false);
	/** The plan that fits, as `data-fit` (for tests and for reading a screenshot). */
	let chosen = $state('');

	const fit: DisplayFit = {
		get tight() {
			return tight;
		},
		drop,
		get shift() {
			return shift;
		},
		get hold() {
			return hold;
		},
		ready: () => {
			composed = true;
		},
	};
	const shown = (index: number) => !hide.includes(index);
	const maxRows = () => widgetRows(rows);

	function apply(plan: FitPlan) {
		tight = plan.tight;
		rows = plan.rows;
		for (const d of [...drop]) if (!plan.drop.includes(d)) drop.delete(d);
		for (const d of plan.drop) drop.add(d);
		hide = plan.hide;
		zoom = plan.zoom;
		shift = plan.shift;
		flushSync();
		relayout();
	}

	/**
	 * Lays the page out from scratch. Chromium up to at least 120 (wall displays' WebViews) loses
	 * the layout of a size container (`container-type`: the clock, the next-up hero) when a plan
	 * moves the block holding it to another grid place in one update (`shift` turns the columns
	 * into `display: contents`): its content stays at zero size, the clock and the hero's text
	 * vanish and the measurement that picks the plan is wrong. Taking the page out of the layout
	 * and back rebuilds every box; it happens within the task, so nothing in between is painted.
	 */
	function relayout() {
		const el = root;
		if (!el) return;
		el.style.display = 'none';
		void el.offsetHeight;
		el.style.display = '';
		void el.offsetHeight;
	}

	/**
	 * Everything inside the screen: the page's own padding below, nothing sideways. Measured on
	 * the parent, which has no `zoom`: browsers before Chrome 128 report the zoomed page's own box
	 * without its zoom, so a page that runs off the screen would seem to fit.
	 */
	function fits(el: HTMLElement): boolean {
		const parent = el.parentElement ?? el;
		const box = parent.getBoundingClientRect();
		return (
			box.top + parent.scrollHeight <= window.innerHeight + 0.5 &&
			box.left + parent.scrollWidth <= window.innerWidth + 0.5 &&
			el.scrollWidth <= el.clientWidth + 1
		);
	}

	/** The groups of blocks (`data-drop`) that show something when nothing is left out. */
	function presentGroups(el: HTMLElement): Set<FitDrop> {
		return new Set(
			[...el.querySelectorAll<HTMLElement>('[data-drop]')]
				.filter((block) => block.getClientRects().length > 0)
				.map((block) => block.dataset.drop as FitDrop),
		);
	}

	/** Tries the plans in order, keeps the first that fits and takes back what still fits. */
	function fitScreen() {
		const el = root;
		if (!el) return;
		const tiles = [...(band?.querySelectorAll<HTMLElement>(':scope > .widget') ?? [])];
		// The widgets that show anything (one with nothing to say is an empty box).
		const present = tiles.flatMap((widget, i) => (widget.childElementCount > 0 ? [i] : []));
		const start = baseZoom(window.innerWidth);
		apply({ tight: 0, rows: 0, drop: [], hide: [], zoom: start, shift: false });
		const groups = presentGroups(el);
		const pick = chooseFit(present, start, (plan) => {
			apply(plan);
			return fits(el);
		});
		apply(pick);
		chosen = describeFit(pick);
		onfit?.(
			leftOut(
				pick,
				tiles.map((tile) => tile.dataset.widget ?? ''),
				groups,
			),
		);
	}

	// Measured once the composition has settled and the page stops changing size (the widgets
	// load on their own); only then is it shown. Afterwards, again on every change of size.
	let lastChange = 0;
	let frame = 0;
	const later = () => {
		if (frame) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			fitScreen();
		});
	};
	$effect(() => {
		const el = root;
		if (!el) return;
		const observer = new ResizeObserver(() => {
			lastChange = performance.now();
			if (!untrack(() => hold)) later();
		});
		observer.observe(el);
		const onResize = () => later();
		window.addEventListener('resize', onResize);
		return () => {
			observer.disconnect();
			window.removeEventListener('resize', onResize);
			cancelAnimationFrame(frame);
			frame = 0;
		};
	});
	$effect(() => {
		if (!composed) return;
		const started = performance.now();
		lastChange = Math.max(lastChange, started);
		let timer = 0;
		const check = () => {
			const now = performance.now();
			if (now - lastChange >= QUIET_MS || now - started >= QUIET_CAP_MS) {
				fitScreen();
				hold = false;
			} else timer = window.setTimeout(check, 50);
		};
		timer = window.setTimeout(check, 50);
		return () => clearTimeout(timer);
	});
</script>

<div
	class="today"
	bind:this={root}
	style:zoom
	data-testid="display-today"
	data-names={showNames}
	data-fit={chosen}
>
	<Composition {data} {status} {fit} band={foot ? widgetBand : undefined} />
</div>

{#snippet widgetBand()}
	<div class="foot" class:pending={hold} bind:this={band} data-testid="display-foot">
		{@render foot?.(shown, maxRows)}
	</div>
{/snippet}

<style>
	/* The band of `display.widget` tiles, where the composition puts it (in its order, the whole
	   width of its grid), in columns of at least 18rem that the tiles fill top to bottom, so a
	   short tile sits under another instead of leaving a gap beside a tall one. A composition may
	   set `--band-display: contents` to lay the tiles out in a grid of its own. */
	.foot {
		order: var(--o, 0);
		grid-column: 1 / -1;
		min-width: 0;
		display: var(--band-display, block);
		columns: 18rem;
		column-gap: 20px;
		margin-bottom: -20px;
	}
	.foot > :global(.widget) {
		break-inside: avoid;
		margin-bottom: 20px;
	}
	.foot:not(:has(> :not(:global(.gone)):not(:empty))) {
		display: none;
	}
	.pending {
		visibility: hidden;
	}
</style>
