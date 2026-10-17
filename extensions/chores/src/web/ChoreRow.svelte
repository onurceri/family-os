<script lang="ts">
	import { Avatar, AwaitingMark } from '@famos/ui/famos';
	import { Check, Repeat } from '@lucide/svelte';
	import type { Chore } from '../contract/index.js';
	import { dueLabel, groupOf } from './form.js';
	import { useChores } from './i18n.js';

	/**
	 * One chore as a tile: a round check (one tap marks it done), the title with when it is due
	 * and whose turn it is, and the way into the editor. The due time is coloured in the meta only,
	 * so the state is said once; the colours on the check and the avatar are the member's, never a
	 * state colour, because a member's colour must not read as "late" or "done".
	 */
	let {
		chore,
		today,
		canDo,
		busy = false,
		waiting = false,
		selected = false,
		ondone,
		onopen,
	}: {
		chore: Chore;
		today: string;
		canDo: boolean;
		busy?: boolean;
		/** The tap is kept on this device and not sent yet. */
		waiting?: boolean;
		selected?: boolean;
		ondone: () => void;
		onopen?: () => void;
	} = $props();

	const { app, t } = useChores();
	const finished = $derived(chore.nextDue === null);
	const group = $derived(groupOf(chore, today));
	const who = $derived(app.members().find((m) => m.id === chore.assigneeId));
	// Why the tick is off: someone else's turn (a guest simply cannot tick, and needs no hint).
	const notYourTurn = $derived(
		!finished && !canDo && who ? t('turn_of', { name: who.displayName }) : null,
	);
	const doer = $derived(app.members().find((m) => m.id === chore.lastDone?.memberId));
	const due = $derived(
		finished && doer
			? t('done_by', { name: doer.displayName })
			: dueLabel(chore.nextDue, today, t, app.dateLocale()),
	);
</script>

<div
	class="flex min-h-12 items-center gap-1 rounded-[var(--r-item)] ps-1 pe-3 transition-colors {finished
		? 'bg-idle text-ink-soft'
		: 'bg-surface text-ink shadow-lit'} {selected ? 'ring-ink ring-2 ring-inset' : ''}"
>
	<button
		type="button"
		onclick={ondone}
		disabled={busy || waiting || finished || !canDo}
		aria-label={notYourTurn
			? `${t('mark_done', { title: chore.title })} (${notYourTurn})`
			: t('mark_done', { title: chore.title })}
		title={notYourTurn ?? undefined}
		class="focus-visible:ring-ring grid size-11 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-2 disabled:opacity-60"
	>
		<span
			class="grid size-[26px] place-items-center rounded-full border-2 transition-colors {finished
				? 'bg-now text-on-color border-transparent'
				: 'border-ink-soft/55 hover:border-now text-transparent'}"
			style:border-color={!finished && who ? who.color : undefined}
		>
			<Check class="size-4" strokeWidth={3} aria-hidden="true" />
		</span>
	</button>
	<button
		type="button"
		onclick={onopen}
		disabled={!onopen}
		class="focus-visible:ring-ring grid min-h-12 min-w-0 flex-1 content-center gap-px rounded-md py-1.5 text-start outline-none focus-visible:ring-2"
	>
		<b class="truncate text-[15px] leading-snug font-semibold {finished ? 'line-through' : ''}"
			>{chore.title}</b
		>
		<small class="flex flex-wrap items-center gap-x-1 text-[13px] leading-snug">
			{#if chore.recurrence}<Repeat class="size-3 shrink-0" aria-hidden="true" />{/if}
			<span
				class="shrink-0 {finished
					? ''
					: group === 'overdue'
						? 'text-attention font-bold'
						: group === 'today'
							? 'text-ink font-semibold'
							: 'text-ink-soft'}">{due}</span
			>
			{#if !finished}
				<span class="text-ink-soft min-w-0 truncate"
					>&middot; {notYourTurn ?? (who ? who.displayName : t('anyone'))}</span
				>
			{/if}
			{#if waiting}
				<span class="shrink-0 font-semibold" data-testid="waiting-mark"
					>&middot; {t('waiting_to_send')}</span
				>
			{/if}
			<AwaitingMark id={chore.id} />
		</small>
	</button>
	{#if !finished && who}
		<Avatar name={who.displayName} color={who.color} size={28} />
	{/if}
</div>
