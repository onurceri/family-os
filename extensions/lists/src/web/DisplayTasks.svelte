<script lang="ts">
	import { todayIn } from '@famos/time';
	import { Avatar, DisplayRow, DisplaySection } from '@famos/ui/famos';
	import { ListChecks } from '@lucide/svelte';
	import { onDestroy } from 'svelte';
	import type { Task } from '../contract/index.js';
	import { loadTasks } from './data.js';
	import { dueLabel, urgency } from './format.js';
	import { useLists } from './i18n.js';

	/**
	 * Family display widget: the open tasks, those due today or overdue first. Read-only.
	 */
	let { rows }: { rows?: number } = $props();
	const { app, t } = useLists();
	const MAX = 7;
	/** Fewer when the display has less room. */
	const max = $derived(Math.min(MAX, rows ?? MAX));
	let now = $state(Date.now());
	const clock = setInterval(() => (now = Date.now()), 60_000);
	onDestroy(() => clearInterval(clock));
	const today = $derived(todayIn(app.timeZone(), now));
	const names = $derived(app.can('core.members.view'));

	let tasks = $state<Task[]>([]);
	async function load() {
		try {
			tasks = await loadTasks();
		} catch {
			// Keep what is on screen; the next refresh tries again.
		}
	}
	$effect(() => {
		void load();
		return app.onEvent('lists.task.', () => void load());
	});

	const byDue = (a: Task, b: Task) =>
		(a.dueDate ?? '').localeCompare(b.dueDate ?? '') ||
		(a.dueTime ?? '').localeCompare(b.dueTime ?? '');
	const open = $derived(tasks.filter((task) => task.doneAt === null));
	/** Due or overdue first, then tasks without a date, then the ones further away. */
	const ordered = $derived.by(() => {
		const due = open.filter((task) =>
			['overdue', 'today'].includes(urgency(task, today, app.weekStart())),
		);
		const undated = open.filter((task) => task.dueDate === null);
		const later = open.filter((task) => !due.includes(task) && task.dueDate !== null);
		return [
			...due.toSorted(byDue).map((task) => ({ task, lit: true })),
			...undated.map((task) => ({ task, lit: false })),
			...later.toSorted(byDue).map((task) => ({ task, lit: false })),
		];
	});
	const assignee = (task: Task) =>
		names ? app.members().find((m) => m.id === task.assigneeId) : undefined;
	const subtitle = (task: Task) =>
		[
			assignee(task)?.displayName ?? null,
			task.dueDate ? dueLabel(task, today, t, app.dateLocale(), app.hourCycle()) : null,
		]
			.filter(Boolean)
			.join(' · ') || undefined;
</script>

<DisplaySection
	title={t('display_tasks')}
	count={open.length ? t('open_tasks', { count: open.length }) : undefined}
>
	{#snippet icon()}<ListChecks class="text-now" />{/snippet}
	{#if open.length === 0}
		<DisplayRow variant="empty" title={t('display_no_tasks')} />
	{:else}
		{#each ordered.slice(0, max) as { task, lit } (task.id)}
			<DisplayRow variant={lit ? 'lit' : 'idle'} title={task.title} subtitle={subtitle(task)}>
				{#snippet lead()}
					{@const member = assignee(task)}
					{#if member}
						<Avatar name={member.displayName} color={member.color} size={32} />
					{:else}
						<span
							class="size-8 shrink-0 rounded-full border-2 {urgency(
								task,
								today,
								app.weekStart(),
							) === 'overdue'
								? 'border-attention'
								: lit
									? 'border-now'
									: 'border-ink-soft/50'}"
							aria-hidden="true"
						></span>
					{/if}
				{/snippet}
			</DisplayRow>
		{/each}
		{#if ordered.length > max}<p class="text-ink-soft px-1 text-[13px]">
				+{ordered.length - max}
			</p>{/if}
	{/if}
</DisplaySection>
