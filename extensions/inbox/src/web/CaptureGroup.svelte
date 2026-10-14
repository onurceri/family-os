<script lang="ts">
	import { Button } from '@famos/ui/button';
	import { Avatar, ConfirmButton } from '@famos/ui/famos';
	import { ChevronDown } from '@lucide/svelte';
	import { approveDraft, dismissItem, rejectDraft, undoDraft } from './data.js';
	import CaptureIcon from './CaptureIcon.svelte';
	import CaptureSource from './CaptureSource.svelte';
	import CaptureStatus from './CaptureStatus.svelte';
	import DraftView from './DraftView.svelte';
	import { approvals, type Edits, withEdit } from './edits.js';
	import { captureTime } from './format.js';
	import { useInbox } from './i18n.js';
	import {
		approveSelectedKey,
		type Capture,
		captureLine,
		groupBusyState,
		pickedDrafts,
	} from './item-view.js';

	/**
	 * One capture and what was found in it, decided together: a line saying what it is, the
	 * original on demand, the suggestions with a tick each, and **Add selected** / **Dismiss the
	 * rest**. While the AI reads, the group says so in place. Decided suggestions stay as small
	 * rows (with Undo) until the page moves the whole group to Recent.
	 */
	let {
		capture,
		onchanged,
	}: {
		capture: Capture;
		/** Called after anything changed here, so the page loads again at once. */
		onchanged?: () => void;
	} = $props();
	const { app, t } = useInbox();

	const item = $derived(capture.item);
	const drafts = $derived(capture.drafts);
	const mine = $derived(item.createdBy === app.me()?.id);
	const author = $derived(app.members().find((m) => m.id === item.createdBy));
	const canDecide = $derived(app.can('core.drafts.approve'));
	const todo = $derived(drafts.filter((d) => d.status === 'pending' || d.status === 'failed'));

	// What waits starts ticked, except what would add a second one; the person's ticks win.
	let choices = $state<ReadonlyMap<string, boolean>>(new Map());
	const picked = $derived(pickedDrafts(todo, choices));
	const pickedIds = $derived(new Set(picked.map((d) => d.id)));
	const rest = $derived(todo.filter((d) => !pickedIds.has(d.id)));
	const setPicked = (id: string, on: boolean) => {
		choices = new Map(choices).set(id, on);
	};

	// Edits saved on cards, approved together with their suggestion.
	let edits = $state<Edits>(new Map());

	let editing = $state<ReadonlySet<string>>(new Set());
	const setEditing = (id: string, on: boolean) => {
		if (editing.has(id) === on) return;
		const next = new Set(editing);
		if (on) next.add(id);
		else next.delete(id);
		editing = next;
	};

	let original = $state(false);
	let busy = $state(false);
	const gate = $derived(groupBusyState({ busy, editing: editing.size, picked: picked.length }));

	async function addSelected() {
		if (busy || picked.length === 0) return;
		busy = true;
		// Said the way the button said it: "added" only when everything adds something.
		const adds = approveSelectedKey(picked) === 'add_selected';
		const undoable: string[] = [];
		let added = 0;
		let failed = 0;
		// One by one, in the order proposed: the same endpoint (and rules) as a single approval.
		for (const { id, input } of approvals(picked, edits)) {
			try {
				const result = await approveDraft(id, input);
				if (result.status === 'applied') {
					added += 1;
					if (result.undoable) undoable.push(result.id);
				} else failed += 1;
			} catch {
				failed += 1;
			}
		}
		busy = false;
		onchanged?.();
		if (added === 0) {
			app.toast(t('error'));
			return;
		}
		const message =
			failed > 0
				? t(adds ? 'added_partial' : 'done_partial', { count: added, failed })
				: t(adds ? 'added_n' : 'done_n', { count: added });
		app.toast(
			message,
			undoable.length
				? { label: app.t('app:draft_undo'), run: () => void undoAll(undoable) }
				: undefined,
		);
	}

	async function undoAll(ids: readonly string[]) {
		const results = await Promise.allSettled(ids.map((id) => undoDraft(id)));
		onchanged?.();
		app.toast(
			results.some((r) => r.status === 'rejected') ? t('error') : app.t('app:draft_undone'),
		);
	}

	async function dismissRest() {
		busy = true;
		try {
			// Nothing is ticked: "the rest" is everything that is left.
			await Promise.all((rest.length > 0 ? rest : todo).map((d) => rejectDraft(d.id)));
		} catch {
			app.toast(t('error'));
		} finally {
			busy = false;
			onchanged?.();
		}
	}

	async function remove() {
		try {
			await dismissItem(item.id);
			onchanged?.();
		} catch {
			app.toast(t('error'));
		}
	}

	const reading = $derived(item.status === 'received' || item.status === 'normalized');
	// Removing is for captures with nothing left to decide; with suggestions "Dismiss" does it. Someone
	// who cannot decide still removes their own capture, which takes its waiting suggestions back.
	const removable = $derived(mine && !reading && (todo.length === 0 || !canDecide));
	const hasSource = $derived(
		Boolean(item.text || item.url || item.title || item.transcript) || item.files.length > 0,
	);
</script>

<article
	class="grid gap-3"
	aria-label={captureLine(item)}
	aria-busy={reading}
	data-testid="capture-group"
>
	<header class="grid gap-2">
		<div class="flex items-start gap-3">
			<span class="text-ink-soft bg-idle grid size-9 shrink-0 place-items-center rounded-full">
				<CaptureIcon {item} />
			</span>
			<div class="grid min-w-0 flex-1 gap-0.5">
				<h3 class="text-[17px] leading-snug font-bold text-balance">{captureLine(item)}</h3>
				<p class="text-ink-soft flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
					<span>{t(`channel_${item.channel}`)} · {captureTime(app, item.createdAt)}</span>
					{#if !mine && author}
						<span class="flex items-center gap-1.5 font-semibold">
							<Avatar name={author.displayName} color={author.color} size={18} />
							{t('from', { name: author.displayName })}
						</span>
					{/if}
				</p>
			</div>
			{#if hasSource}
				<button
					type="button"
					aria-expanded={original}
					onclick={() => (original = !original)}
					class="text-ink-soft hover:text-ink hover:bg-idle -my-1 flex min-h-11 shrink-0 items-center gap-1 rounded-[var(--r-ctl)] px-2.5 text-[13px] font-semibold"
				>
					{original ? t('hide_original') : t('show_original')}
					<ChevronDown
						class="size-4 transition-transform {original ? 'rotate-180' : ''}"
						aria-hidden="true"
					/>
				</button>
			{/if}
		</div>
		{#if original}
			<div class="bg-idle rounded-[var(--r-item)] p-3"><CaptureSource {item} /></div>
		{/if}
	</header>

	<CaptureStatus {item} />

	{#if drafts.length}
		<div
			class="grid grid-cols-[repeat(auto-fit,minmax(min(18rem,100%),1fr))] items-start gap-3"
			data-testid="suggestions"
		>
			{#each drafts as draft (draft.id)}
				{@const open = draft.status === 'pending' || draft.status === 'failed'}
				<div class={!open || editing.has(draft.id) ? 'col-span-full' : ''}>
					<DraftView
						{draft}
						compact
						quiet
						picked={pickedIds.has(draft.id)}
						onpick={open && canDecide ? (on) => setPicked(draft.id, on) : undefined}
						oneditchange={(on) => setEditing(draft.id, on)}
						onedit={open && canDecide
							? (input) => (edits = withEdit(edits, draft.id, input))
							: undefined}
						onreplaced={() => {
							edits = withEdit(edits, draft.id, undefined);
							// The person chose the change: it goes in with the others.
							setPicked(draft.id, true);
							onchanged?.();
						}}
						byline={false}
					/>
				</div>
			{/each}
		</div>
	{/if}

	{#if todo.length > 0 && canDecide}
		<footer class="flex flex-wrap items-center justify-end gap-2">
			{#if gate.hint}
				<p class="text-ink-soft mr-auto text-sm" role="status">{t('save_edit_first')}</p>
			{/if}
			<ConfirmButton
				label={picked.length > 0 && rest.length > 0 ? t('dismiss_rest') : t('dismiss_all')}
				confirmLabel={t('dismiss_rest_confirm')}
				onconfirm={dismissRest}
				disabled={gate.dismissDisabled}
			/>
			<Button size="lg" disabled={gate.addDisabled} onclick={addSelected}
				>{t(approveSelectedKey(picked), { n: picked.length })}</Button
			>
		</footer>
	{:else if removable}
		<footer class="flex justify-end">
			<ConfirmButton label={t('dismiss')} confirmLabel={t('dismiss_confirm')} onconfirm={remove} />
		</footer>
	{/if}
</article>
