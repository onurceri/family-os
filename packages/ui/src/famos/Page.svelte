<script lang="ts" module>
	const FRAMED = Symbol('famos.page');
</script>

<script lang="ts">
	import { getContext, type Snippet, setContext } from 'svelte';
	import { PAGE_WIDTH, type PageTemplate } from './page-frame.js';
	import PageHeader from './PageHeader.svelte';

	/**
	 * The one page frame: every page renders inside it, and it alone
	 * decides a page's width and centring. The template picks a width class (`page-frame.ts`); pages
	 * of one class share their maximum width and their left edge, so titles line up. A page never
	 * writes its own width, centring or negative margins (a test enforces it).
	 *
	 * The shell's `<main>` keeps only the gutters and tells the frame what they are
	 * (`--shell-x`, `--shell-top`, `--shell-bottom`, the preview bar included), so the Board can
	 * bleed into them and the Chat can fill the window.
	 *
	 * A Page inside a Page (a `ListDetail` in a page that already has its frame) adds no second
	 * frame: the outer one decides.
	 */
	let {
		template,
		title,
		subtitle,
		actions,
		aside,
		backdrop,
		children,
	}: {
		template: PageTemplate;
		/** The page head; omit when the page draws its own (a record header, the calendar's bar). */
		title?: string;
		subtitle?: string;
		actions?: Snippet;
		/** Chat only: a pane beside the conversation (the history), at the frame's left edge. */
		aside?: Snippet;
		/** Board only: what is drawn under the page, edge to edge (the cork). */
		backdrop?: Snippet;
		children?: Snippet;
	} = $props();

	const nested = getContext<boolean>(FRAMED) === true;
	setContext(FRAMED, true);

	const width = $derived(PAGE_WIDTH[template]);
</script>

{#snippet body()}
	{#if title}<PageHeader {title} {subtitle} {actions} />{/if}
	{@render children?.()}
{/snippet}

{#if nested}
	{@render body()}
{:else if template === 'settings'}
	<!-- Settings measure their own width: sections marked `settings-pair` sit side by side from
	     80 rem of room, and the column opens up for them. -->
	<div class="zone">
		<div class="page medium" data-page={template} data-width={width}>{@render body()}</div>
	</div>
{:else}
	<div
		class="page {width}"
		class:bleed={template === 'board'}
		class:fill={template === 'chat'}
		class:paired={Boolean(aside)}
		data-page={template}
		data-width={width}
	>
		{#if backdrop}<div class="backdrop" aria-hidden="true">{@render backdrop()}</div>{/if}
		{#if aside}
			<div class="aside">{@render aside()}</div>
			<div class="column">{@render body()}</div>
		{:else}
			{@render body()}
		{/if}
	</div>
{/if}

<style>
	.page {
		width: 100%;
		min-width: 0;
		margin-inline: auto;
	}
	.narrow {
		max-width: 760px;
	}
	.medium {
		max-width: 60rem;
	}
	.standard {
		max-width: 1200px;
	}
	.zone {
		container-type: inline-size;
		width: 100%;
		min-width: 0;
	}
	@container (min-width: 80rem) {
		.medium:has(:global(.settings-pair)) {
			max-width: 76rem;
		}
	}
	/* The Board: edge to edge over the shell's gutters, at least as tall as the window. Its padding
	   gives the gutters back, so its title starts where every full page's title starts. */
	.bleed {
		position: relative;
		isolation: isolate;
		width: auto;
		min-height: 100vh;
		min-height: 100dvh;
		margin: calc(-1 * var(--shell-top, 0px)) calc(-1 * var(--shell-x, 0px))
			calc(-1 * var(--shell-bottom, 0px));
		padding: var(--shell-top, 0px) var(--shell-x, 0px) var(--shell-bottom, 0px);
	}
	.backdrop {
		position: absolute;
		inset: 0;
		z-index: -1;
		display: grid;
	}
	/* Chat fills the window under the shell's top gutter down to the dock (above the phone's tab
	   bar, 1 rem from the bottom elsewhere): its message box sits at the bottom even in a short
	   conversation. The bottom margin takes back the shell's bottom gutter down to the dock. */
	.fill {
		--chat-dock: calc(4.5rem + env(safe-area-inset-bottom));
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		min-height: calc(100vh - var(--shell-top, 0px) - var(--chat-dock));
		min-height: calc(100dvh - var(--shell-top, 0px) - var(--chat-dock));
		margin-bottom: calc(var(--chat-dock) - var(--shell-bottom, 0px));
	}
	@media (min-width: 48rem) {
		.fill {
			--chat-dock: 1rem;
		}
	}
	.column {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		min-width: 0;
	}
	/* Chat with its history, from 1280 px: the history is a pane that hugs the frame's left edge and
	   runs its whole height, a hairline at its end (as the shell's sidebar has); the 760 px
	   conversation is centred in the room beside it. */
	@media (min-width: 80rem) {
		.paired {
			display: grid;
			grid-template-columns: 16.25rem minmax(0, 1fr);
			column-gap: 2.5rem;
			max-width: none;
		}
		.paired > .aside {
			min-width: 0;
			/* The hairline runs from the window's top to its bottom, as the sidebar's does. */
			margin-block: calc(-1 * var(--shell-top, 0px)) calc(-1 * var(--chat-dock));
			padding-block: var(--shell-top, 0px) var(--chat-dock);
			padding-inline-end: 1rem;
			border-inline-end: 1px solid var(--line);
		}
		.paired > .column {
			width: 100%;
			max-width: 760px;
			margin-inline: auto;
		}
	}
</style>
