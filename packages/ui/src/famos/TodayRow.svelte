<script lang="ts">
	import type { Component, Snippet } from 'svelte';

	/**
	 * One row of Today. `needs`: a row inside the lit Needs you card (56 px, inline actions);
	 * `note`: a tile on the wall (48 px, `surface` + `shadow-lit`, title 600; `idle` recedes it for done or
	 * receded rows); `outline`: the Coming up strip (1 px line).
	 * A leading check (tasks, chores), a kind icon in a disc, or nothing; trailing actions or an
	 * avatar on the right. With `href` the title is the link.
	 */
	let {
		title,
		meta,
		metaTone = 'soft',
		variant = 'note',
		idle = false,
		href,
		icon,
		check,
		checkLabel,
		busy = false,
		oncheck,
		uncertain = false,
		wrap = false,
		leading,
		trailing,
		below,
	}: {
		title: string;
		meta?: string;
		/** `attention` for overdue, `heat` for due soon. */
		metaTone?: 'soft' | 'attention' | 'heat' | 'ink';
		variant?: 'needs' | 'note' | 'outline';
		/** A `note` row that recedes into the wall (done, or not about now). */
		idle?: boolean;
		href?: string;
		/** A kind icon, drawn in a 36 px `idle` disc. */
		icon?: Component;
		/** A round check target: `false` open, `true` done; omit for none. */
		check?: boolean;
		checkLabel?: string;
		busy?: boolean;
		oncheck?: () => void;
		/** Dashed `attention` underline under the meta ("check this"). */
		uncertain?: boolean;
		/** The meta wraps instead of being cut with "…" (a sentence that must be read whole). */
		wrap?: boolean;
		leading?: Snippet;
		trailing?: Snippet;
		/** Full-width content under the row (an editor). */
		below?: Snippet;
	} = $props();

	const frame = $derived(
		variant === 'needs'
			? 'min-h-14 px-4 py-2'
			: variant === 'note'
				? `min-h-12 rounded-[var(--r-item)] px-1.5 py-1 ${idle ? 'bg-idle' : 'bg-surface shadow-lit'}`
				: 'border-line min-h-14 rounded-xl border px-3 py-2',
	);
	const tone = $derived(
		metaTone === 'attention'
			? 'text-attention font-semibold'
			: metaTone === 'heat'
				? 'text-heat font-semibold'
				: metaTone === 'ink'
					? 'text-ink font-semibold'
					: 'text-ink-soft',
	);
</script>

<div class="min-w-0">
	<div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 {frame}">
		{#if check !== undefined}
			<button
				type="button"
				onclick={oncheck}
				disabled={busy || !oncheck}
				aria-pressed={check}
				aria-label={checkLabel ?? title}
				class="focus-visible:ring-ring -my-1 grid size-11 shrink-0 place-items-center rounded-full focus-visible:ring-2 focus-visible:outline-none {variant ===
				'needs'
					? '-ml-1.5'
					: ''}"
			>
				<span
					class="grid size-7 place-items-center rounded-full border-2 {check
						? 'bg-now text-on-color border-transparent'
						: 'border-ink-soft/55 text-transparent'}"
				>
					<svg
						class="size-4"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="3"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg
					>
				</span>
			</button>
		{:else if icon}
			{@const Icon = icon}
			<span
				class="bg-idle text-ink-soft grid size-9 shrink-0 place-items-center rounded-full"
				aria-hidden="true"><Icon class="size-5" /></span
			>
		{:else if leading}
			{@render leading()}
		{/if}
		<div
			class="grid min-w-0 flex-1 basis-40 gap-0.5 {variant === 'note' && check === undefined
				? 'pl-2.5'
				: ''}"
		>
			{#if href}
				<a
					{href}
					class="focus-visible:ring-ring truncate rounded-sm text-[15px] leading-snug font-semibold hover:underline focus-visible:ring-2 focus-visible:outline-none {check
						? 'line-through opacity-60'
						: ''}">{title}</a
				>
			{:else}
				<b
					class="truncate text-[15px] leading-snug font-semibold {check
						? 'line-through opacity-60'
						: ''}">{title}</b
				>
			{/if}
			{#if meta}
				<small
					class="{wrap ? 'text-pretty' : 'truncate'} text-[13px] leading-snug {tone} {uncertain
						? 'decoration-attention underline decoration-dashed underline-offset-4'
						: ''}">{meta}</small
				>
			{/if}
		</div>
		{#if trailing}
			<div class="ml-auto flex shrink-0 items-center gap-1.5 {variant === 'note' ? 'pr-2' : ''}">
				{@render trailing()}
			</div>
		{/if}
	</div>
	{#if below}{@render below()}{/if}
</div>
