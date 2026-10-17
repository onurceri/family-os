<script lang="ts">
	import type { Component, Snippet } from 'svelte';
	import type { DraftField } from '../slots.js';
	import ConfirmButton from './ConfirmButton.svelte';
	import { draftButtons } from './draft-buttons.js';

	/**
	 * A draft proposed by AI (or a child) waiting for a parent.
	 * Pending: coral ring, fields, uncertain fields marked "check this", Reject (two taps) ·
	 * Edit · Approve. Applied: green ring. Rejected, undone or expired: receded. Failed: error and
	 * retry.
	 * Labels come from the app so this component stays i18n-free.
	 */
	export type DraftCardStatus =
		'pending' | 'applied' | 'rejected' | 'failed' | 'undone' | 'expired';
	export interface DraftCardLabels {
		approve: string;
		edit: string;
		save: string;
		cancel: string;
		reject: string;
		rejectConfirm: string;
		checkThis: string;
		applied: string;
		rejected: string;
		retry: string;
		/** Shown instead of the buttons to people who cannot decide (children). */
		waiting?: string;
		/** Shown after an applied draft was taken back. */
		undone?: string;
		/** Shown when nobody decided it and the day it was about has passed. */
		expired?: string;
		/** Shown when what it was about no longer exists. */
		gone?: string;
		/** Shown when what it asked for was already so, so approving it changed nothing. */
		settled?: string;
		/** Second tap on Approve when it may already be there. */
		approveConfirm?: string;
		/** Shown after the person who suggested it took it back. */
		withdrawn?: string;
		/** The button with which the person who suggested it takes it back. */
		withdraw?: string;
		/** The button that takes an applied draft back. */
		undo?: string;
		/** The button with which the person behind an undone draft sends it again. */
		suggestAgain?: string;
		/** Shown on a pending draft that seems to exist already. */
		mayExist?: string;
		/** Shown on a pending draft of which only some things exist already. */
		mayExistSome?: string;
		/** The approve button of a draft that offers to change what is there instead. */
		addAsNew?: string;
	}

	let {
		kind,
		icon,
		title,
		source,
		fields,
		uncertain = [],
		mayExist = false,
		mayExistSome = false,
		instead,
		status,
		error,
		labels,
		busy = false,
		canDecide = true,
		reason = null,
		askedBy,
		compact = false,
		editor,
		onapprove,
		onreject,
		onsave,
		onundo,
		onwithdraw,
		onsuggestagain,
		selectable,
		quiet = false,
		oneditchange,
	}: {
		kind: string;
		icon?: Component;
		title: string;
		source?: string;
		fields: readonly DraftField[];
		uncertain?: readonly string[];
		/** What it proposes seems to be there already (same title and date). */
		mayExist?: boolean;
		/** Some, not all, of what it proposes is there already. */
		mayExistSome?: boolean;
		/**
		 * It could change what is already there instead (move the event on the calendar): what is
		 * there, the button's words, and what choosing it does. Adding it stays possible.
		 */
		instead?: { there: string; action: string; onchoose: () => void };
		status: DraftCardStatus;
		error?: string | null;
		labels: DraftCardLabels;
		busy?: boolean;
		/** False for people who may not approve (children see the proposal and a waiting note). */
		canDecide?: boolean;
		/** Why a rejected draft is closed when nobody decided it on its merits. */
		reason?: 'gone' | 'settled' | 'withdrawn' | null;
		/** Who asked for it, when it was somebody other than the viewer ("Asked by Noah"). */
		askedBy?: string;
		/** A decided draft as one flat row (wide layouts); pending drafts are unchanged. */
		compact?: boolean;
		/** Inline editor (from the extension's presenter); shown in edit mode. */
		editor?: Snippet;
		onapprove: () => void;
		onreject: () => void;
		/** Approve with the edited input; omit to hide "Edit". */
		onsave?: () => void;
		/** Shown on an applied draft that can still be taken back; omit to hide "Undo". */
		onundo?: () => void;
		/**
		 * For the person behind a suggestion they cannot decide themselves: a button under the
		 * waiting note that takes it back. Omit to hide "Withdraw".
		 */
		onwithdraw?: () => void;
		/**
		 * For the person behind an undone draft: a button that sends it again as a new suggestion.
		 * Omit to hide "Suggest again".
		 */
		onsuggestagain?: () => void;
		/**
		 * A suggestion in a group that is decided together: a checkbox instead of Approve and
		 * Reject (the group has the buttons); Edit stays. Only for people who may decide.
		 */
		selectable?: { checked: boolean; label: string; onchange(checked: boolean): void };
		/**
		 * Inside a group of suggestions on its own page: a calm card (no alarm ring); a ticked one
		 * has a soft outline, an unticked one recedes.
		 */
		quiet?: boolean;
		/** Tells the group when the editor opens or closes, so it can give the card the whole row. */
		oneditchange?: (editing: boolean) => void;
	} = $props();

	let editing = $state(false);
	$effect(() => oneditchange?.(editing));
	const unsure = (f: DraftField) =>
		[...(f.path ? [f.path] : []), ...(f.paths ?? [])].some((p) => uncertain.includes(p));
	const picking = $derived(
		Boolean(selectable) && canDecide && (status === 'pending' || status === 'failed'),
	);
	/** Approving something that may already be there takes a second tap, as rejecting does. */
	const warned = $derived(
		(mayExist || mayExistSome || Boolean(instead)) && Boolean(labels.approveConfirm),
	);
	const offered = $derived(canDecide && status === 'pending' ? instead : undefined);
	const buttons = $derived(draftButtons({ offered: Boolean(offered), warned, picking }));
	const approveLabel = $derived(
		status === 'failed'
			? labels.retry
			: offered && labels.addAsNew
				? labels.addAsNew
				: labels.approve,
	);
	// Quiet (inside a conversation or a capture): an ordinary filled button at the end.
	const filledLook = $derived(
		quiet
			? 'min-h-11 px-4 bg-ink text-wall ms-auto'
			: 'min-h-11 px-4 bg-attention text-on-color flex-1',
	);
	// Beside the offered change, adding it as new is a plain secondary button.
	const approveLook = $derived(
		buttons.approve === 'secondary-confirm' ? 'min-h-11 px-4 bg-idle text-ink' : filledLook,
	);
	/** What a draft that did not go in says. */
	const settled = $derived(
		status === 'undone'
			? (labels.undone ?? labels.rejected)
			: status === 'expired'
				? (labels.expired ?? labels.rejected)
				: reason === 'gone'
					? (labels.gone ?? labels.rejected)
					: reason === 'settled'
						? (labels.settled ?? labels.rejected)
						: reason === 'withdrawn'
							? (labels.withdrawn ?? labels.rejected)
							: labels.rejected,
	);
	const ring = $derived(
		quiet && (status === 'pending' || status === 'failed')
			? picking && !selectable?.checked
				? 'bg-idle ring-1 ring-border'
				: picking
					? 'ring-2 ring-ink/20'
					: 'ring-1 ring-border'
			: status === 'pending' || status === 'failed'
				? picking && !selectable?.checked
					? 'ring-1 ring-border opacity-80'
					: 'ring-2 ring-attention'
				: status === 'applied'
					? 'ring-2 ring-now'
					: 'opacity-60',
	);
</script>

{#if compact && status !== 'pending' && status !== 'failed'}
	<article
		class="bg-surface flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-4 py-3 {status ===
		'applied'
			? ''
			: 'opacity-60'}"
		aria-busy={busy}
	>
		<span class="text-ink-soft text-xs font-bold tracking-wider uppercase">{kind}</span>
		<h3 class="min-w-0 flex-1 truncate text-sm font-extrabold">{title}</h3>
		<p
			class="{status === 'applied' ? 'text-now' : 'text-ink-soft'} text-sm font-bold"
			role="status"
		>
			{#if status === 'applied'}✓ {labels.applied}{:else}{settled}{/if}
		</p>
		{#if status === 'applied' && onundo && labels.undo}
			<button
				type="button"
				disabled={busy}
				class="bg-idle min-h-11 rounded-lg px-4 text-sm font-bold disabled:opacity-50"
				onclick={onundo}
			>
				{labels.undo}
			</button>
		{:else if status === 'undone' && onsuggestagain && labels.suggestAgain}
			<button
				type="button"
				disabled={busy}
				class="bg-idle min-h-11 rounded-lg px-4 text-sm font-bold disabled:opacity-50"
				onclick={onsuggestagain}
			>
				{labels.suggestAgain}
			</button>
		{/if}
	</article>
{:else}
	<article class="bg-surface shadow-lit grid gap-3 rounded-xl p-4 {ring}" aria-busy={busy}>
		<div class={picking ? 'flex items-start gap-3' : 'contents'}>
			{#if picking && selectable}
				<input
					type="checkbox"
					checked={selectable.checked}
					onchange={(e) => selectable.onchange(e.currentTarget.checked)}
					aria-label={selectable.label}
					disabled={busy}
					class="accent-ink mt-0.5 size-6 shrink-0"
				/>
			{/if}
			<div class={picking ? 'grid min-w-0 flex-1 gap-3' : 'contents'}>
				<div
					class="text-ink-soft flex items-center gap-2 text-xs font-bold tracking-wider uppercase"
				>
					{#if icon}{@const Icon = icon}<Icon class="size-4" aria-hidden="true" />{/if}
					<span>{kind}</span>
				</div>
				<h3 class="text-lg leading-snug font-extrabold text-balance">{title}</h3>
				{#if source}<p class="text-ink-soft -mt-2 text-xs">{source}</p>{/if}
				{#if askedBy}<p class="text-ink-soft -mt-2 text-xs font-semibold">{askedBy}</p>{/if}
			</div>
		</div>

		{#if status === 'applied'}
			<p class="text-now text-sm font-bold" role="status">✓ {labels.applied}</p>
			{#if onundo && labels.undo}
				<button
					type="button"
					disabled={busy}
					class="bg-idle min-h-11 justify-self-start rounded-lg px-4 font-bold disabled:opacity-50"
					onclick={onundo}
				>
					{labels.undo}
				</button>
			{/if}
		{:else if status === 'rejected' || status === 'undone' || status === 'expired'}
			<p class="text-ink-soft text-sm" role="status">{settled}</p>
			{#if status === 'undone' && onsuggestagain && labels.suggestAgain}
				<button
					type="button"
					disabled={busy}
					class="bg-idle min-h-11 justify-self-start rounded-lg px-4 font-bold disabled:opacity-50"
					onclick={onsuggestagain}
				>
					{labels.suggestAgain}
				</button>
			{/if}
		{:else if editing && editor}
			<!-- The editor sizes its fields from this container, not from the window. -->
			<div class="@container grid gap-3">{@render editor()}</div>
			<div class="flex flex-wrap gap-2">
				<button
					type="button"
					class="text-ink-soft min-h-11 rounded-lg px-3 font-bold"
					onclick={() => (editing = false)}
				>
					{labels.cancel}
				</button>
				<button
					type="button"
					disabled={busy}
					class="bg-now text-on-color min-h-11 flex-1 rounded-lg px-3 font-bold disabled:opacity-50"
					onclick={() => {
						editing = false;
						onsave?.();
					}}
				>
					{labels.save}
				</button>
			</div>
		{:else}
			<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
				{#each fields as field (field.label)}
					<dt class="text-ink-soft">{field.label}</dt>
					<dd class="font-semibold">
						<span
							class={unsure(field)
								? 'decoration-attention underline decoration-dashed underline-offset-4'
								: ''}
						>
							{field.value}
						</span>
						{#if unsure(field)}<span class="text-attention ml-1 text-xs font-medium"
								>· {labels.checkThis}</span
							>{/if}
					</dd>
				{/each}
			</dl>
			{#if offered}
				<div class="grid gap-2">
					<p class="text-attention text-sm font-semibold">{offered.there}</p>
					{#if buttons.offer === 'outline'}
						<button
							type="button"
							disabled={busy}
							class="border-line text-ink hover:bg-idle min-h-11 justify-self-start rounded-lg border px-4 text-start font-bold disabled:opacity-50"
							onclick={offered.onchoose}
						>
							{offered.action}
						</button>
					{/if}
				</div>
			{:else if canDecide && mayExist && status === 'pending' && labels.mayExist}
				<p class="text-attention text-sm font-semibold">{labels.mayExist}</p>
			{:else if canDecide && mayExistSome && status === 'pending' && labels.mayExistSome}
				<p class="text-attention text-sm font-semibold">{labels.mayExistSome}</p>
			{/if}
			{#if status === 'failed' && error}
				<p class="text-attention text-sm font-semibold" role="alert">{error}</p>
			{/if}
			{#if !canDecide}
				<p class="text-ink-soft text-sm font-semibold">{labels.waiting}</p>
				{#if onwithdraw && labels.withdraw}
					<button
						type="button"
						disabled={busy}
						class="bg-idle min-h-11 justify-self-start rounded-lg px-4 font-bold disabled:opacity-50"
						onclick={onwithdraw}
					>
						{labels.withdraw}
					</button>
				{/if}
			{:else if picking}
				{#if onsave && editor}
					<div class="flex">
						<button
							type="button"
							disabled={busy}
							class="bg-idle min-h-11 rounded-lg px-4 font-bold disabled:opacity-50"
							onclick={() => (editing = true)}
						>
							{labels.edit}
						</button>
					</div>
				{/if}
			{:else}
				<div class="flex flex-wrap items-center gap-2">
					<ConfirmButton
						label={labels.reject}
						confirmLabel={labels.rejectConfirm}
						onconfirm={onreject}
						disabled={busy}
					/>
					{#if onsave && editor}
						<button
							type="button"
							disabled={busy}
							class="bg-idle min-h-11 rounded-lg px-4 font-bold disabled:opacity-50"
							onclick={() => (editing = true)}
						>
							{labels.edit}
						</button>
					{/if}
					{#if (buttons.approve === 'primary-confirm' || buttons.approve === 'secondary-confirm') && status === 'pending' && labels.approveConfirm}
						<ConfirmButton
							label={approveLabel}
							confirmLabel={labels.approveConfirm}
							onconfirm={onapprove}
							disabled={busy}
							look={approveLook}
						/>
					{:else}
						<button
							type="button"
							disabled={busy}
							class={['rounded-lg font-bold disabled:opacity-50', approveLook]}
							onclick={onapprove}
						>
							{approveLabel}
						</button>
					{/if}
					{#if offered && buttons.offer === 'primary'}
						<button
							type="button"
							disabled={busy}
							class={['rounded-lg text-start font-bold disabled:opacity-50', filledLook]}
							onclick={offered.onchoose}
						>
							{offered.action}
						</button>
					{/if}
				</div>
			{/if}
		{/if}
	</article>
{/if}
