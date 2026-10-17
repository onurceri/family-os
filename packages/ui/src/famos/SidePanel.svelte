<script lang="ts" module>
	/** What the "discard changes?" dialog says (already translated). */
	export type DiscardLabels = {
		title: string;
		description?: string;
		keep: string;
		discard: string;
	};
</script>

<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import type { Approval } from '../app-context.js';
	import { Button } from '../components/button/index.js';
	import Dialog from './Dialog.svelte';
	import { openPath } from './open-path.js';
	import Sheet from './Sheet.svelte';
	import { wide } from './wide.svelte.js';

	/**
	 * Details and forms next to the page. On windows 1024 px wide and
	 * more it is a panel on the right (360 px up to 1279, 420 px above) and the page stays visible;
	 * on narrower ones it is a `Sheet` with Cancel, the title and Save. The width decides, never the
	 * device. Esc closes (asks first when `dirty`); `Cmd/Ctrl+Enter` saves; focus moves in and
	 * returns to what opened it.
	 *
	 * The footer is `Save` (ink) and `Cancel` (ghost) with `danger` (a two-tap button) at the far
	 * right; give `onsave` for Save, or a whole `footer` of your own. A form inside submits through
	 * `onsave` (for example `form.requestSubmit()`). Without `onsave` and `footer` there is no footer
	 * (a details view).
	 *
	 * Closing: `beforeclose` may veto (return `false`, or a promise of it); `dirty` with `discard`
	 * labels asks in a dialog. After closing, `closeHref` is opened through the router (the `?edit=`
	 * or `?new=` address of the panel goes away); the page still gets `onclose`.
	 */
	let {
		open,
		title,
		onclose,
		closeLabel,
		cancelLabel,
		saveLabel,
		onsave,
		saveDisabled = false,
		danger,
		footer,
		dirty = false,
		discard,
		beforeclose,
		closeHref,
		approval,
		children,
	}: {
		open: boolean;
		title: string;
		onclose: () => void;
		/** Accessible name of the close button (already translated). */
		closeLabel: string;
		/** The Cancel button; defaults to `closeLabel`. */
		cancelLabel?: string;
		saveLabel?: string;
		onsave?: () => void;
		saveDisabled?: boolean;
		/** A destructive two-tap button, at the far right of the footer. */
		danger?: Snippet;
		/** A footer of your own, instead of Save, Cancel and `danger`. */
		footer?: Snippet;
		dirty?: boolean;
		discard?: DiscardLabels;
		/** Return `false` (or a promise of it) to keep the panel open. */
		beforeclose?: () => boolean | Promise<boolean>;
		/** Opened through the router after closing: the page's address without `?edit=` or `?new=`. */
		closeHref?: string;
		/**
		 * Given when the change goes to someone for approval (`app.approval(actionId)`): its line is
		 * said under the title, where it is seen before anything is typed, and Save reads as the
		 * suggestion it is.
		 */
		approval?: Approval;
		children: Snippet;
	} = $props();

	let panel = $state<HTMLElement>();
	let opener: HTMLElement | null = null;
	let asking = $state(false);

	const shownSaveLabel = $derived(approval?.saveLabel ?? saveLabel);
	const hasFooter = $derived(Boolean(footer || (onsave && shownSaveLabel)));

	$effect(() => {
		if (!open || !wide.current) return;
		opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		void tick().then(() => {
			// The first field if there is one, else the panel itself.
			const first = panel?.querySelector<HTMLElement>(
				'input:not([type=hidden]), select, textarea, [data-autofocus]',
			);
			(first ?? panel)?.focus();
		});
		return () => {
			if (opener?.isConnected) opener.focus();
			opener = null;
		};
	});

	$effect(() => {
		if (!open) asking = false;
	});

	function finish() {
		asking = false;
		onclose();
		if (closeHref) openPath(closeHref, { replace: true });
	}

	async function requestClose() {
		if (beforeclose && (await beforeclose()) === false) return;
		if (dirty && discard) {
			asking = true;
			return;
		}
		finish();
	}

	function onkeydown(e: KeyboardEvent) {
		if (!open || !wide.current || e.defaultPrevented) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			void requestClose();
		} else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && onsave && !saveDisabled) {
			e.preventDefault();
			onsave();
		}
	}
</script>

<svelte:window {onkeydown} />

{#snippet bottom()}
	{#if footer}
		{@render footer()}
	{:else}
		{#if onsave && shownSaveLabel}
			<Button variant="primary" disabled={saveDisabled} onclick={onsave}>{shownSaveLabel}</Button>
			<Button variant="ghost" onclick={requestClose}>{cancelLabel ?? closeLabel}</Button>
		{/if}
		{#if danger}<span class="ms-auto flex flex-wrap items-center gap-1">{@render danger()}</span
			>{/if}
	{/if}
{/snippet}

{#if open}
	{#if wide.current}
		<div
			bind:this={panel}
			role="dialog"
			aria-modal="false"
			aria-label={title}
			tabindex="-1"
			data-testid="side-panel"
			data-surface="card"
			class="bg-surface shadow-pop border-line fixed inset-y-0 end-0 z-40 flex w-[22.5rem] flex-col border-s outline-none xl:w-[26.25rem]"
		>
			<header class="border-line flex h-14 shrink-0 items-center gap-3 border-b ps-5 pe-3">
				<h2 class="min-w-0 flex-1 truncate text-[17px] font-extrabold">{title}</h2>
				<button
					type="button"
					onclick={requestClose}
					aria-label={closeLabel}
					class="text-ink-soft hover:bg-idle hover:text-ink flex size-9 shrink-0 items-center justify-center rounded-[var(--r-ctl)] outline-none focus-visible:shadow-[0_0_0_2px_var(--wall),0_0_0_4px_var(--info)]"
				>
					<svg
						class="size-5"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg
					>
				</button>
			</header>
			{#if approval}
				<p
					class="text-ink-soft border-line shrink-0 border-b px-5 py-2.5 text-[13px]"
					data-testid="side-panel-note"
				>
					{approval.note}
				</p>
			{/if}
			<div class="min-h-0 flex-1 overflow-y-auto p-5">{@render children()}</div>
			{#if hasFooter}
				<footer
					class="border-line bg-surface flex shrink-0 flex-wrap items-center gap-2 border-t px-5 py-3"
					data-testid="side-panel-footer"
				>
					{@render bottom()}
				</footer>
			{/if}
		</div>
	{:else}
		<Sheet
			{open}
			{title}
			testid="side-panel"
			onclose={requestClose}
			{onsave}
			saveLabel={shownSaveLabel}
			note={approval?.note}
			{saveDisabled}
			cancelLabel={cancelLabel ?? closeLabel}
		>
			{@render children()}
			{#if danger && !footer}
				<div class="border-line mt-6 flex flex-wrap items-center gap-1 border-t pt-3">
					{@render danger()}
				</div>
			{/if}
			{#if footer}
				<div class="mt-6 flex flex-wrap items-center gap-2">{@render footer()}</div>
			{/if}
		</Sheet>
	{/if}
{/if}

{#if discard}
	<Dialog
		open={asking}
		title={discard.title}
		description={discard.description}
		onclose={() => (asking = false)}
	>
		{#snippet actions()}
			<Button variant="ghost" data-autofocus onclick={() => (asking = false)}>{discard.keep}</Button
			>
			<Button variant="danger" onclick={finish}>{discard.discard}</Button>
		{/snippet}
	</Dialog>
{/if}
