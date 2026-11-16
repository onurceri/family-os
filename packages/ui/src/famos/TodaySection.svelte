<script lang="ts">
	import type { Snippet } from 'svelte';
	import TodayBlockMenu from './TodayBlockMenu.svelte';

	/**
	 * A band of Today: a small label with its count, a link to the page it comes from, and rows
	 * on the wall (no card chrome). Extensions render this inside their `dashboard.card`. The
	 * label takes the style's caps size and tracking (`--ramp-label`). Inside a `TodayBlock`
	 * that may be hidden the label row ends with its `...` menu ("Hide from Today").
	 */
	let {
		title,
		count,
		href,
		more,
		dot = false,
		children,
	}: {
		title: string;
		/** After the title, in normal weight ("3 open"). */
		count?: string;
		/** The page the section comes from; `more` is the link's text. */
		href?: string;
		more?: string;
		/** A small `attention` dot before the title (Needs you). */
		dot?: boolean;
		children: Snippet;
	} = $props();
</script>

<section class="grid min-w-0 content-start gap-2.5">
	<div class="row flex min-h-6 items-baseline gap-2">
		{#if dot}<span class="bg-attention size-2 shrink-0 self-center rounded-full" aria-hidden="true"
			></span>{/if}
		<h2
			class="text-ink-soft min-w-0 truncate text-[length:var(--ramp-label,13px)] font-bold tracking-[var(--ramp-label-tracking,0.06em)] uppercase"
		>
			{title}{#if count}<span class="ml-2 font-semibold tracking-normal normal-case">{count}</span
				>{/if}
		</h2>
		<span class="end ml-auto flex shrink-0 items-baseline empty:hidden">
			{#if href && more}
				<a
					{href}
					class="text-ink-soft hover:text-ink focus-visible:ring-ring shrink-0 rounded-sm text-xs font-bold focus-visible:ring-2 focus-visible:outline-none"
					>{more}</a
				>
			{/if}
			<TodayBlockMenu />
		</span>
	</div>
	<div class="grid gap-1.5">
		{@render children()}
	</div>
</section>

<style>
	.end {
		position: relative;
	}
	.end > :global(.today-block-menu) {
		margin-inline-start: 4px;
	}
	/* With a mouse the ⋯ only shows while the section is hovered or focused. It sits just before
	   the link, out of the flow, so the link ("Calendar") stays at the column's edge and nothing
	   moves when it appears; the title keeps room for it, so a long one truncates before it. It
	   stays inside its own column: past the row's end it would cover the next column's label
	   wherever the gap between them is narrower than the button. On touch it is always there,
	   after the link. */
	@media (hover: hover) and (pointer: fine) {
		.row:has(:global(.today-block-menu)) > h2 {
			/* The 36 px button and its 4 px margin, less the row's 8 px gap. */
			margin-inline-end: 32px;
		}
		.end > :global(.today-block-menu) {
			position: absolute;
			inset-inline-end: 100%;
			top: 50%;
			margin-block: 0;
			margin-inline: 0 4px;
			translate: 0 -50%;
		}
		/* The translate makes the ⋯ its own stacking layer, so its open menu would sit under
		   anything positioned that comes later on the page (a chore ring); raise it while open. */
		.end > :global(.today-block-menu:has([aria-expanded='true'])) {
			z-index: 50;
		}
	}
</style>
