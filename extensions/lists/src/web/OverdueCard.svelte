<script lang="ts">
	import { addDays, todayIn } from '@famos/time';
	import { TodayRow } from '@famos/ui/famos';
	import type { SlotProps } from '@famos/ui/slots';
	import { onDestroy } from 'svelte';
	import type { Task } from '../contract/index.js';
	import { completeTask, loadTasks, reopenTask, saveTask } from './data.js';
	import { urgency } from './format.js';
	import { useLists } from './i18n.js';
	import { taskFormFrom, taskInputFrom } from './task-form.js';

	/**
	 * Today, Needs you: tasks that are late and are this person's (or anyone's), with "Tomorrow"
	 * and "Done" inline. It renders only rows; the page owns the card.
	 */
	let { size, report }: SlotProps['dashboard.card'] = $props();
	const { app, t } = useLists();
	let now = $state(Date.now());
	const clock = setInterval(() => (now = Date.now()), 60_000);
	onDestroy(() => clearInterval(clock));
	const today = $derived(todayIn(app.timeZone(), now));

	let tasks = $state<Task[]>([]);
	let loaded = $state(false);
	let busy = $state<Record<string, true>>({});
	async function load() {
		try {
			tasks = await loadTasks();
		} catch {
			tasks = [];
		} finally {
			loaded = true;
		}
	}
	$effect(() => {
		void app.offline();
		void load();
		return app.onEvent('lists.task.', () => void load());
	});

	const late = $derived.by(() => {
		const meId = app.me()?.id;
		return tasks
			.filter(
				(task) =>
					task.doneAt === null &&
					urgency(task, today, app.weekStart()) === 'overdue' &&
					(task.assigneeId === meId || task.assigneeId === null),
			)
			.toSorted((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
	});
	const shown = $derived(late.slice(0, 5));
	// Reports only once loaded: the page waits for the first report.
	$effect(() => {
		if (loaded) report({ count: late.length, quietKey: '', urgent: late.length });
	});

	const daysLate = (task: Task) =>
		Math.max(1, Math.round((Date.parse(today) - Date.parse(task.dueDate ?? today)) / 86_400_000));
	const metaOf = (task: Task) =>
		[
			t('overdue_days', { count: daysLate(task) }),
			app.members().find((m) => m.id === task.assigneeId)?.displayName ?? t('anyone'),
		].join(' · ');

	async function done(task: Task) {
		busy[task.id] = true;
		try {
			const after = await completeTask(app, task, t('label_complete', { title: task.title }));
			if (after === 'queued') app.toast(t('queued_toast'));
			else
				app.toast(t('completed'), {
					label: t('undo'),
					run: () => void reopenTask(app, task.id, t('label_reopen', { title: task.title })),
				});
		} catch {
			app.toast(t('error'));
		} finally {
			delete busy[task.id];
		}
	}
	async function tomorrow(task: Task) {
		busy[task.id] = true;
		try {
			const form = taskFormFrom(task, today);
			await saveTask(taskInputFrom({ ...form, dueDate: addDays(today, 1) }), task.id);
			await load();
		} catch {
			app.toast(t('error'));
		} finally {
			delete busy[task.id];
		}
	}
	// A repeating task moves on by itself; only a one-off task can be put off by a day.
	const canPostpone = (task: Task) => !task.recurrence && !task.rrule;
</script>

{#if size !== 'line'}
	{#each shown as task (task.id)}
		<TodayRow
			variant="needs"
			title={task.title}
			meta={metaOf(task)}
			metaTone="attention"
			check={false}
			checkLabel={t('mark_done_task', { title: task.title })}
			busy={task.id in busy}
			oncheck={() => done(task)}
		>
			{#snippet trailing()}
				{#if canPostpone(task)}
					<button
						type="button"
						onclick={() => tomorrow(task)}
						disabled={task.id in busy}
						class="text-ink-soft hover:bg-idle focus-visible:ring-ring min-h-11 rounded-lg px-3 text-sm font-bold focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
						>{t('due_tomorrow')}</button
					>
				{/if}
				<button
					type="button"
					onclick={() => done(task)}
					disabled={task.id in busy}
					class="bg-idle text-ink focus-visible:ring-ring min-h-11 rounded-lg px-4 text-sm font-bold focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
					>{t('completed')}</button
				>
			{/snippet}
		</TodayRow>
	{/each}
	{#if late.length > shown.length}
		<a
			href="/lists/tasks"
			class="text-ink-soft hover:text-ink block px-4 py-3 text-sm font-semibold"
			>{t('today_more', { count: late.length - shown.length })}</a
		>
	{/if}
{/if}
