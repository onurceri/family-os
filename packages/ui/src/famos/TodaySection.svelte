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
	<div class="flex min-h-6 items-baseline gap-2">
		{#if dot}<span class="bg-attention size-2 shrink-0 self-center rounded-full" aria-hidden="true"
			></span>{/if}
		<h2
			class="text-ink-soft min-w-0 truncate text-[length:var(--ramp-label,13px)] font-bold tracking-[var(--ramp-label-tracking,0.06em)] uppercase"
		>
			{title}{#if count}<span class="ml-2 font-semibold tracking-normal normal-case">{count}</span
				>{/if}
		</h2>
		<span class="ml-auto flex shrink-0 items-baseline empty:hidden [&>.today-block-menu]:ms-1">
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
