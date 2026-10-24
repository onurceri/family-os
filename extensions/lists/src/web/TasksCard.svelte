<script lang="ts">
	import { todayIn } from '@famos/time';
	import { TodayRow, TodaySection } from '@famos/ui/famos';
	import type { SlotProps } from '@famos/ui/slots';
	import { useNow } from '@famos/ui/now';
	import type { Task } from '../contract/index.js';
	import { completeTask, loadTasks, reopenTask } from './data.js';
	import { dueLabel, urgency } from './format.js';
	import { useLists } from './i18n.js';

	/**
	 * Today, notes band: the open tasks that are not late (the late ones are in Needs you), what is
	 * due first and mine before the others; tick off in place.
	 */
	let { size, report }: SlotProps['dashboard.card'] = $props();
	const { app, t } = useLists();
	const mayTick = $derived(app.access('lists.completeTask') !== 'no');
	const clock = useNow();
	const now = $derived(clock.current);
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
		void app.offline(); // load again when the connection is back
		void load();
		return app.onEvent('lists.task.', () => void load());
	});

	const RANK = { today: 0, soon: 1, nextWeek: 2, later: 3, none: 4, overdue: 5 } as const;
	const open = $derived.by(() => {
		const meId = app.me()?.id;
		return tasks
			.filter((task) => task.doneAt === null && urgency(task, today, app.weekStart()) !== 'overdue')
			.toSorted(
				(a, b) =>
					RANK[urgency(a, today, app.weekStart())] - RANK[urgency(b, today, app.weekStart())] ||
					Number(b.assigneeId === meId) - Number(a.assigneeId === meId),
			);
	});
	const limit = $derived(size === 'wide' ? 5 : 3);
	const shown = $derived(open.slice(0, limit));

	// Reports only once loaded: the page keeps the last report while a card moves between columns.
	$effect(() => {
		if (!loaded) return;
		report({
			count: open.length,
			quietKey: 'lists:quiet_tasks',
			urgent: open.filter((task) => urgency(task, today, app.weekStart()) === 'today').length,
		});
	});

	const metaOf = (task: Task) =>
		[
			app.members().find((m) => m.id === task.assigneeId)?.displayName ?? t('anyone'),
			dueLabel(task, today, t, app.dateLocale(), app.hourCycle()),
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
</script>

{#if size !== 'line'}
	<TodaySection
		title={t('tasks')}
		count={t('today_open', { count: open.length })}
		href="/lists/tasks"
		more={t('nav')}
	>
		{#each shown as task (task.id)}
			<TodayRow
				title={task.title}
				meta={metaOf(task)}
				metaTone={urgency(task, today, app.weekStart()) === 'today' ? 'heat' : 'soft'}
				check={mayTick ? false : undefined}
				checkLabel={t('mark_done_task', { title: task.title })}
				busy={task.id in busy}
				oncheck={() => done(task)}
			/>
		{/each}
		{#if open.length > shown.length}
			<a href="/lists/tasks" class="text-ink-soft hover:text-ink px-2.5 py-1 text-sm font-semibold"
				>{t('today_more', { count: open.length - shown.length })}</a
			>
		{/if}
	</TodaySection>
{/if}
