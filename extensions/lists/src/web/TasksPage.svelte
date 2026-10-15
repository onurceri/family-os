<script lang="ts">
	import { formatDate, todayIn } from '@famos/time';
	import { Composer, ConfirmButton, EmptyArt, Page, Segmented, SidePanel } from '@famos/ui/famos';
	import { ChevronRight } from '@lucide/svelte';
	import { onDestroy } from 'svelte';
	import { TASK_TITLE_MAX, type Task } from '../contract/index.js';
	import {
		completeTask,
		deleteTask,
		loadTask,
		loadTasks,
		type Outcome,
		reopenTask,
		saveTask,
	} from './data.js';
	import { groupTasks, type Urgency } from './format.js';
	import { useLists } from './i18n.js';
	import ListsHeader from './ListsHeader.svelte';
	import TaskForm from './TaskForm.svelte';
	import TaskRow from './TaskRow.svelte';
	import {
		emptyTask,
		type TaskFormValue,
		taskFormFrom,
		taskInputFrom,
		validateTask,
	} from './task-form.js';

	/**
	 * The Tasks page: the add field on top, the open tasks by when they are due (Overdue, Today,
	 * This week, Later, No date), then Done, folded. Everyone's or only mine. The details open in
	 * the side panel, or in a sheet on phones.
	 */
	const { app, t } = useLists();
	let mine = $state(false);
	let now = $state(Date.now());
	const clock = setInterval(() => (now = Date.now()), 60_000);
	onDestroy(() => clearInterval(clock));
	const today = $derived(todayIn(app.timeZone(), now));

	let tasks = $state<Task[]>([]);
	let loadError = $state(false);
	let loadedOnce = $state(false);
	/** Optimistic state: ids being toggled, with the done state shown meanwhile. */
	let pending = $state<Record<string, boolean>>({});

	async function load() {
		try {
			tasks = await loadTasks();
			loadError = false;
		} catch {
			loadError = true;
		} finally {
			loadedOnce = true;
		}
	}
	$effect(() => {
		void app.offline(); // load again when the connection is back
		void load();
		return app.onEvent('lists.task.', () => void load());
	});

	// Changes kept on this device while offline: shown as if saved, marked "waiting".
	const queued = $derived(
		new Map(
			app
				.waiting()
				.filter((w) => w.actionId === 'lists.completeTask' || w.actionId === 'lists.reopenTask')
				.map((w) => [(w.input as { id: string }).id, w.actionId === 'lists.completeTask'] as const),
		),
	);
	// When waiting changes were sent (the queue got shorter), read the tasks again.
	let waitingBefore = 0;
	$effect(() => {
		const n = app.waiting().length;
		if (n < waitingBefore) void load();
		waitingBefore = n;
	});
	const isDone = (task: Task) => pending[task.id] ?? queued.get(task.id) ?? task.doneAt !== null;
	const me = $derived(app.me());
	// By when it is due, for everyone or just me.
	const LABELS: Record<Urgency, () => string> = {
		overdue: () => t('group_overdue'),
		today: () => t('group_today'),
		soon: () => t('group_week'),
		later: () => t('group_later'),
		none: () => t('group_no_date'),
	};
	const groups = $derived(groupTasks(tasks, today, mine ? (me?.id ?? null) : null));
	const openCount = $derived(groups.reduce((n, g) => n + g.tasks.length, 0));
	const done = $derived(tasks.filter((task) => task.doneAt !== null));
	// On a wide page (container 70 rem) what is near and what is later sit side by side, but only
	// when both sides have something: never a half-empty column.
	const near = $derived(
		groups.filter((g) => g.key === 'overdue' || g.key === 'today' || g.key === 'soon'),
	);
	const far = $derived(groups.filter((g) => g.key === 'later' || g.key === 'none'));
	const split = $derived(near.length > 0 && far.length > 0);
	let showDone = $state(false);

	function report(outcome: Outcome, message: string) {
		if (outcome === 'queued') app.toast(t('queued_toast'));
		else if (outcome === 'drafted') app.sentForApproval();
		else app.toast(message);
	}

	async function toggle(task: Task) {
		const wasDone = task.doneAt !== null;
		pending[task.id] = !wasDone;
		try {
			if (wasDone) {
				report(
					await reopenTask(app, task.id, t('label_reopen', { title: task.title })),
					t('reopened'),
				);
			} else {
				const after = await completeTask(app, task, t('label_complete', { title: task.title }));
				const next = after && after !== 'queued' && after.doneAt === null ? after.dueDate : null;
				app.toast(
					after === 'queued'
						? t('queued_toast')
						: next
							? t('completed_next', {
									date: formatDate(next, app.dateLocale(), {
										weekday: 'long',
										day: 'numeric',
										month: 'long',
									}),
								})
							: t('completed'),
					after === 'queued'
						? undefined
						: {
								label: t('undo'),
								run: () =>
									void reopenTask(app, task.id, t('label_reopen', { title: task.title })).then(
										load,
									),
							},
				);
			}
			await load();
		} catch {
			app.toast(t('error'));
		} finally {
			delete pending[task.id];
		}
	}

	// Quick add: one line. Without the edit capability it is assigned to me, so it needs no approval.
	let quick = $state('');
	const defaultAssignee = $derived(me && !app.can('lists.tasks.edit') ? me.id : null);

	// False when it failed, so the composer gives the typing back.
	async function quickAdd(title: string): Promise<boolean> {
		try {
			report(await saveTask({ title, assigneeId: defaultAssignee }), t('saved'));
			return true;
		} catch {
			app.toast(t('error'));
			return false;
		}
	}

	// Full editor for a new task (from the composer text) or an existing one.
	let editingId = $state<string | 'new' | null>(null);
	let form = $state<TaskFormValue | null>(null);
	let formEl = $state<HTMLFormElement | null>(null);

	// A new task of one's own is added at once; anything else may go to someone for approval.
	const approvalNote = $derived(
		app.needsApproval('lists.tasks.edit') &&
			!(editingId === 'new' && form?.assignee[0] === app.me()?.id)
			? app.t('app:draft_approval_note')
			: undefined,
	);
	let showErrors = $state(false);
	let saveError = $state(false);
	let busy = $state(false);
	let snapshot = '';
	const errors = $derived(form && showErrors ? validateTask(form) : {});
	const dirty = $derived(form !== null && JSON.stringify(form) !== snapshot);

	function openEditor(value: TaskFormValue, id: string | 'new') {
		form = value;
		snapshot = JSON.stringify(value);
		editingId = id;
		showErrors = saveError = false;
	}

	function openNew(text: string) {
		openEditor({ ...emptyTask(defaultAssignee, today), title: text.trim() }, 'new');
		quick = '';
	}

	async function openEdit(task: Task) {
		try {
			openEditor(taskFormFrom(await loadTask(task.id), today), task.id);
		} catch {
			app.toast(t('error'));
		}
	}

	function close() {
		editingId = null;
		form = null;
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!form || !editingId) return;
		showErrors = true;
		if (Object.keys(validateTask(form)).length) return;
		busy = true;
		saveError = false;
		try {
			report(
				await saveTask(taskInputFrom(form), editingId === 'new' ? undefined : editingId),
				t('saved'),
			);
			close();
		} catch {
			saveError = true;
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!editingId || editingId === 'new') return;
		try {
			report(await deleteTask(editingId), t('deleted'));
			close();
		} catch {
			app.toast(t('error'));
		}
	}
</script>

{#snippet taskList(list: Task[], receded: boolean)}
	<ul
		class="bg-surface divide-line grid divide-y rounded-[var(--r-card)] shadow-[inset_0_0_0_1px_var(--line)]"
	>
		{#each list as task (task.id)}
			<li>
				<TaskRow
					{task}
					{today}
					done={isDone(task)}
					busy={task.id in pending}
					waiting={queued.has(task.id)}
					ontoggle={() => toggle(task)}
					onopen={receded ? undefined : () => openEdit(task)}
				/>
			</li>
		{/each}
	</ul>
{/snippet}

{#snippet groupSection(group: { key: Urgency; tasks: Task[] })}
	<section class="grid gap-2.5" aria-labelledby="tasks-group-{group.key}">
		<div
			class="flex items-baseline gap-2 text-xs {group.key === 'overdue'
				? 'text-attention'
				: 'text-ink-soft'}"
		>
			<h2 id="tasks-group-{group.key}" class="font-bold tracking-[0.06em] uppercase">
				{LABELS[group.key]()}
			</h2>
			<span class="font-semibold">{group.tasks.length}</span>
		</div>
		{@render taskList(group.tasks, false)}
	</section>
{/snippet}

{#snippet deleteButton()}
	<ConfirmButton label={t('delete')} confirmLabel={t('delete_confirm')} onconfirm={remove} />
{/snippet}

{#snippet filter()}
	<Segmented
		size="sm"
		label={t('tasks_filter')}
		options={[
			{ value: 'everyone', label: t('filter_everyone') },
			{ value: 'mine', label: t('filter_mine') },
		]}
		value={mine ? 'mine' : 'everyone'}
		onchange={(v) => (mine = v === 'mine')}
	/>
{/snippet}

<Page template="list">
	<div class="@container">
		<ListsHeader
			page="tasks"
			count={openCount ? t('today_open', { count: openCount }) : ''}
			actions={tasks.length ? filter : undefined}
		/>

		<div class="grid gap-7">
			<Composer
				bind:value={quick}
				size="lg"
				limit={TASK_TITLE_MAX}
				tooLong={(counter) => t('too_long', { counter })}
				label={t('add_task')}
				placeholder={t('add_task_placeholder')}
				moreLabel={t('add_task_details')}
				onsubmit={quickAdd}
				onmore={openNew}
			/>

			{#if loadError}
				<p class="text-attention font-semibold">{t('error')}</p>
			{:else if loadedOnce && groups.length === 0}
				<div
					class="text-ink-soft flex flex-col items-center gap-2 py-6 text-center"
					data-testid="empty-state"
				>
					<EmptyArt name="tasks" />
					<p class="max-w-[34ch] text-[15px] leading-snug text-pretty">
						<span class="text-ink font-semibold">{mine ? t('no_tasks_mine') : t('no_tasks')}</span>
						{mine ? '' : t('no_tasks_hint')}
					</p>
				</div>
			{/if}

			{#if groups.length}
				<div class="grid items-start gap-7 {split ? '@[60rem]:grid-cols-2 @[60rem]:gap-10' : ''}">
					<div class="grid gap-7">
						{#each split ? near : groups as group (group.key)}{@render groupSection(group)}{/each}
					</div>
					{#if split}
						<div class="grid gap-7">
							{#each far as group (group.key)}{@render groupSection(group)}{/each}
						</div>
					{/if}
				</div>
			{/if}

			{#if done.length}
				<section class="grid gap-2" aria-label={t('done_group')}>
					<button
						type="button"
						class="text-ink-soft hover:text-ink flex min-h-11 w-fit items-center gap-1.5 text-start text-[13px] font-bold tracking-[0.06em] uppercase"
						aria-expanded={showDone}
						onclick={() => (showDone = !showDone)}
					>
						<ChevronRight
							class="size-4 transition-transform motion-reduce:transition-none {showDone
								? 'rotate-90'
								: ''}"
						/>
						{t('done_group')} · {done.length}
					</button>
					{#if showDone}{@render taskList(done, true)}{/if}
				</section>
			{/if}
		</div>
	</div>
</Page>

<SidePanel
	open={Boolean(editingId && form)}
	title={editingId === 'new' ? t('new_task') : t('edit_task')}
	onclose={close}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={editingId === 'new' ? t('add') : t('save')}
	saveDisabled={busy}
	onsave={() => formEl?.requestSubmit()}
	note={approvalNote}
	danger={editingId && editingId !== 'new' ? deleteButton : undefined}
	{dirty}
	discard={{
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	}}
>
	{#if editingId && form}
		<form bind:this={formEl} onsubmit={submit} class="grid gap-5" novalidate>
			<TaskForm bind:value={form} {errors} />
			{#if saveError}<p class="text-attention text-sm font-semibold" role="alert">
					{t('error')}
				</p>{/if}
			<button type="submit" class="sr-only" tabindex="-1" aria-hidden="true">{t('save')}</button>
		</form>
	{/if}
</SidePanel>
