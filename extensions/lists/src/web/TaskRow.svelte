<script lang="ts">
	import { Avatar, AwaitingMark } from '@famos/ui/famos';
	import { Check, Repeat } from '@lucide/svelte';
	import type { Task } from '../contract/index.js';
	import { dueLabel, urgency } from './format.js';
	import { useLists } from './i18n.js';

	/**
	 * One task as a row of a group's card: a round tick (it completes), the title and when it is
	 * due in soft text (it opens the details), the person's avatar at the end. Only the due text
	 * is `attention` when it is late. The person's name is read out, the avatar shows it.
	 */
	let {
		task,
		today,
		done,
		busy = false,
		waiting = false,
		ontoggle,
		onopen,
	}: {
		task: Task;
		today: string;
		done: boolean;
		busy?: boolean;
		/** The change is kept on this device and not sent yet. */
		waiting?: boolean;
		ontoggle: () => void;
		onopen?: () => void;
	} = $props();

	const { app, t } = useLists();
	const level = $derived(urgency(task, today));
	const assignee = $derived(app.members().find((m) => m.id === task.assigneeId));
	const due = $derived(
		task.dueDate ? dueLabel(task, today, t, app.dateLocale(), app.hourCycle()) : null,
	);
	const repeats = $derived(Boolean(task.recurrence || task.rrule));
</script>

<div class="flex min-h-14 items-center gap-1 ps-1 pe-3 {done ? 'text-ink-soft' : 'text-ink'}">
	<button
		type="button"
		onclick={ontoggle}
		disabled={busy}
		aria-pressed={done}
		aria-label={done ? t('mark_open') : t('mark_done')}
		class="group grid size-11 shrink-0 place-items-center rounded-full"
	>
		<span
			class="grid size-[26px] place-items-center rounded-full border-2 transition-colors motion-reduce:transition-none {done
				? 'bg-now text-on-color border-transparent'
				: 'border-ink-soft/55 group-hover:border-now text-transparent'}"
		>
			<Check class="size-4" strokeWidth={3} />
		</span>
	</button>
	<button
		type="button"
		onclick={onopen}
		disabled={!onopen}
		class="grid min-w-0 flex-1 gap-px py-2 pe-2 text-start"
	>
		<span class="truncate text-[15px] leading-snug font-semibold {done ? 'line-through' : ''}"
			>{task.title}</span
		>
		{#if due || repeats || waiting || app.awaitsApproval(task.id)}
			<span
				class="flex items-center gap-1 truncate text-[13px] {!done && level === 'overdue'
					? 'text-attention font-semibold'
					: 'text-ink-soft'}"
			>
				{#if repeats}<Repeat class="size-3 shrink-0" aria-hidden="true" />{/if}
				{#if due}<span class="truncate">{due}</span>{/if}
				{#if waiting}
					<span class="shrink-0 font-semibold" data-testid="waiting-mark"
						>{due ? '· ' : ''}{t('waiting_to_send')}</span
					>
				{/if}
				<AwaitingMark id={task.id} />
			</span>
		{/if}
		<span class="sr-only">{assignee?.displayName ?? t('anyone')}</span>
	</button>
	<span class="shrink-0 {done ? 'opacity-60' : ''}" aria-hidden="true">
		{#if assignee}
			<Avatar name={assignee.displayName} color={assignee.color} size={28} />
		{:else}
			<Avatar name={t('anyone')} color="" size={28} anyone />
		{/if}
	</span>
</div>
