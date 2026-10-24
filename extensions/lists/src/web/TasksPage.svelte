<script lang="ts">
	import { useNow } from '@famos/ui/now';
	import { describeRecurrence, formatDate, todayIn } from '@famos/time';
	import {
		AwaitingMark,
		AwaitingRow,
		Composer,
		ConfirmButton,
		removeLabels,
		DetailRows,
		EmptyArt,
		focusFirstInvalid,
		Page,
		readFirst,
		RepeatScope,
		type RepeatScopeChoice,
		Segmented,
		SidePanel,
		ViewOnly,
	} from '@famos/ui/famos';
	import { ChevronRight } from '@lucide/svelte';
	import { TASK_TITLE_MAX, type Task } from '../contract/index.js';
	import {
		addTask,
		completeTask,
		deleteTask,
		loadTask,
		loadTasks,
		type Outcome,
		reopenTask,
		saveTask,
	} from './data.js';
	import { taskLink } from './deep-link.js';
	import { dueLabel, groupTasks, type Urgency } from './format.js';
	import { revealRow } from './reveal.js';
	import { useLists } from './i18n.js';
	import ListsHeader from './ListsHeader.svelte';
	import TaskForm from './TaskForm.svelte';
	import TaskRow from './TaskRow.svelte';
	import {
		asksWhichOnes,
		emptyTask,
		fromThisTask,
		onlyThisTask,
		type TaskFormValue,
		taskChoices,
		taskFormFrom,
		taskInputFrom,
		validateTask,
	} from './task-form.js';

	/**
	 * The Tasks page: the add field on top, the open tasks by when they are due (Overdue, Today,
	 * This week, Next week, Later, No date), then Done, folded. Everyone's or only mine. The details open in
	 * the side panel, or in a sheet on phones.
	 */
	const { app, t } = useLists();
	let mine = $state(false);
	const clock = useNow();
	const now = $derived(clock.current);
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
		nextWeek: () => t('group_next_week'),
		later: () => t('group_later'),
		none: () => t('group_no_date'),
	};
	const groups = $derived(
		groupTasks(tasks, today, app.weekStart(), mine ? (me?.id ?? null) : null),
	);
	const openCount = $derived(groups.reduce((n, g) => n + g.tasks.length, 0));
	const done = $derived(tasks.filter((task) => task.doneAt !== null));
	// On a wide page (container 70 rem) what is near and what is later sit side by side, but only
	// when both sides have something: never a half-empty column.
	const near = $derived(
		groups.filter(
			(g) => g.key === 'overdue' || g.key === 'today' || g.key === 'soon' || g.key === 'nextWeek',
		),
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

	// What the viewer may do. A control they may not use is not drawn. Whether a task is theirs to
	// change, or to delete, is decided by the server for the task at hand.
	const mayAdd = $derived(app.access('lists.addTask') !== 'no');
	const mayTick = $derived(app.access('lists.completeTask') !== 'no');
	const mayOpen = $derived(app.access('lists.updateTask') !== 'no');

	// Quick add: one line. Whoever may not add a task for anyone is given it for themselves, so it
	// needs no approval; the title does not decide that, so any will do to ask.
	let quick = $state('');
	const defaultAssignee = $derived(
		me && app.accessFor('lists.addTask', { title: 'Task', assigneeId: null }) !== 'apply'
			? me.id
			: null,
	);

	// False when it failed, so the composer gives the typing back.
	async function quickAdd(title: string): Promise<boolean> {
		try {
			const { outcome, id } = await addTask({ title, assigneeId: defaultAssignee });
			report(outcome, t('saved'));
			// A task in a long group lands below the fold: bring it into view.
			if (id) revealRow('data-task-id', id);
			return true;
		} catch {
			app.toast(t('error'));
			return false;
		}
	}

	// Full editor for a new task (from the composer text) or an existing one.
	let editingId = $state<string | 'new' | null>(null);
	let form = $state<TaskFormValue | null>(null);
	// The task as it was when it opened: its details, for someone whose change would wait.
	let opened = $state<Task | null>(null);
	let formEl = $state<HTMLFormElement | null>(null);

	// What saving the open form would do, asked of the server with what is typed: a task of one's
	// own is saved at once, anything else may go to someone for approval. The title never decides
	// it, so an empty one is asked as a placeholder.
	const approval = $derived.by(() => {
		if (!form || !editingId) return undefined;
		const task = { ...taskInputFrom(form), title: form.title.trim() || 'Task' };
		return editingId === 'new'
			? app.approval('lists.addTask', task)
			: app.approval('lists.updateTask', {
					id: editingId,
					task,
					...(form.repeat === 'custom' && { keepRule: true }),
				});
	});
	const mayDelete = $derived(
		editingId !== null &&
			editingId !== 'new' &&
			app.accessFor('lists.deleteTask', { id: editingId }) !== 'no',
	);
	let showErrors = $state(false);
	let saveError = $state<string | null>(null);
	let busy = $state(false);
	let snapshot = '';
	const errors = $derived(form && showErrors ? validateTask(form) : {});
	const dirty = $derived(form !== null && JSON.stringify(form) !== snapshot);

	function openEditor(value: TaskFormValue, id: string | 'new') {
		form = value;
		snapshot = JSON.stringify(value);
		editingId = id;
		showErrors = false;
		saveError = null;
	}

	function openNew(text: string) {
		openEditor({ ...emptyTask(defaultAssignee), title: text.trim() }, 'new');
		quick = '';
	}

	async function openEdit(task: Task) {
		try {
			const full = await loadTask(task.id);
			opened = full;
			openEditor(taskFormFrom(full), task.id);
		} catch {
			app.toast(t('error'));
		}
	}

	function close() {
		editingId = null;
		form = null;
		opened = null;
	}

	// An address that names a task (`?task=…`, from an answer card) brings it into view and, for
	// whoever may open tasks, opens its details. The address is cleaned afterwards, so Back leaves
	// the page and a reload does not open it again.
	const wanted = $derived(taskLink(app.query()));
	let handledTask = '';
	$effect(() => {
		if (!wanted || !loadedOnce || wanted === handledTask) return;
		handledTask = wanted;
		const found = tasks.find((task) => task.id === wanted);
		app.setQuery({ task: null }, { replace: true });
		if (!found) return;
		if (found.doneAt !== null) showDone = true;
		revealRow('data-task-id', found.id);
		if (mayOpen) void openEdit(found);
	});

	// New tasks someone asked for that wait for approval: quiet rows until they are decided.
	const waitingNew = $derived(app.awaitedNew(['lists.addTask']));
	// A waiting task says when it is due, as a saved one does.
	type WaitingTaskDue = { dueDate?: string | null; dueTime?: string | null };
	const dueOf = (input: WaitingTaskDue) =>
		input.dueDate
			? dueLabel(
					{ dueDate: input.dueDate, dueTime: input.dueTime ?? null },
					today,
					t,
					app.dateLocale(),
					app.hourCycle(),
				)
			: undefined;
	const reading = $derived(
		opened && editingId === opened.id
			? readFirst(app, 'lists.updateTask', taskDetails, {
					input: { id: opened.id, task: taskInputFrom(taskFormFrom(opened)) },
					key: opened.id,
				})
			: undefined,
	);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!form || !editingId) return;
		showErrors = true;
		if (Object.keys(validateTask(form)).length) {
			void focusFirstInvalid(event.currentTarget);
			return;
		}
		// A saved repeating task whose date or days moved asks which ones the change is for.
		if (opened && editingId !== 'new' && asksWhichOnes(taskFormFrom(opened), form)) {
			asking = true;
			return;
		}
		await commit();
	}

	let asking = $state(false);
	const choices = $derived(
		opened && form && editingId !== 'new' ? taskChoices(taskFormFrom(opened), form, today) : null,
	);
	const scopeWords = $derived.by(() => {
		const date = (d: string | undefined) => (d ? formatDate(d, app.dateLocale()) : '');
		return {
			title: t('scope_title'),
			only: {
				label: t('scope_only'),
				hint: t('scope_only_hint', { date: date(choices?.onlyDate) }),
			},
			following: {
				label: t('scope_following'),
				hint: t('scope_following_hint', { date: date(choices?.nextDate) }),
			},
			cancel: t('cancel'),
		};
	});
	function pick(choice: RepeatScopeChoice) {
		asking = false;
		void commit(choice);
	}

	async function commit(scope?: RepeatScopeChoice) {
		if (!form || !editingId) return;
		busy = true;
		saveError = null;
		try {
			if (editingId === 'new') {
				const { outcome, id } = await addTask(taskInputFrom(form));
				report(outcome, t('saved'));
				if (id) revealRow('data-task-id', id);
			} else if (scope && opened) {
				const saved = taskFormFrom(opened);
				if (scope === 'this') {
					const { task, onlyThisDate } = onlyThisTask(saved, form, today);
					report(await saveTask(task, editingId, onlyThisDate), t('saved'));
				} else report(await saveTask(fromThisTask(saved, form, today), editingId), t('saved'));
			} else
				report(
					await saveTask(taskInputFrom(form), editingId, undefined, form.repeat === 'custom'),
					t('saved'),
				);
			close();
		} catch (error) {
			saveError = app.failureText(error, t('error'));
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
		class="bg-surface divide-line grid grid-cols-[minmax(0,1fr)] divide-y rounded-[var(--r-card)] shadow-[inset_0_0_0_1px_var(--line)]"
	>
		{#each list as task (task.id)}
			<li data-task-id={task.id}>
				<TaskRow
					{task}
					{today}
					done={isDone(task)}
					busy={task.id in pending}
					waiting={queued.has(task.id)}
					{mayTick}
					ontoggle={() => toggle(task)}
					onopen={receded || !mayOpen ? undefined : () => openEdit(task)}
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

{#snippet taskDetails()}
	{#if opened}
		{@const task = opened}
		<div class="grid gap-5">
			<AwaitingMark id={task.id} />
			<DetailRows
				rows={[
					{ label: t('field_title'), value: task.title },
					{
						label: t('who'),
						value: app.members().find((m) => m.id === task.assigneeId)?.displayName ?? t('anyone'),
					},
					{
						label: t('due'),
						value: task.dueDate
							? dueLabel(task, today, t, app.dateLocale(), app.hourCycle())
							: t('no_due'),
					},
					{
						label: t('repeat'),
						value: task.recurrence
							? describeRecurrence(
									task.recurrence as Parameters<typeof describeRecurrence>[0],
									t,
									app.dateLocale(),
									app.weekStart(),
									task.dueDate ?? undefined,
								)
							: task.rrule
								? t('repeat_custom')
								: null,
					},
					{ label: t('notes'), value: task.notes },
				]}
			/>
		</div>
	{/if}
{/snippet}

{#snippet deleteButton()}
	<ConfirmButton
		{...removeLabels(
			app,
			'lists.deleteTask',
			{ label: t('delete'), confirmLabel: t('delete_confirm') },
			editingId ? { id: editingId } : undefined,
		)}
		onconfirm={remove}
	/>
{/snippet}

{#snippet viewOnly()}
	<ViewOnly />
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
			actions={tasks.length ? filter : mayAdd || mayTick ? undefined : viewOnly}
		/>

		<div class="grid gap-7">
			{#if mayAdd}
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
			{/if}

			{#if loadError}
				<p class="text-attention font-semibold">{t('error')}</p>
			{:else if loadedOnce && groups.length === 0 && waitingNew.length === 0}
				<div
					class="text-ink-soft flex flex-col items-center gap-2 py-6 text-center"
					data-testid="empty-state"
				>
					<EmptyArt name="tasks" />
					<p class="max-w-[34ch] text-[15px] leading-snug text-pretty">
						<span class="text-ink font-semibold">{mine ? t('no_tasks_mine') : t('no_tasks')}</span>
						{mine || !mayAdd ? '' : t('no_tasks_hint')}
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

			{#if waitingNew.length}
				<section class="grid gap-2.5" aria-labelledby="tasks-group-waiting">
					<div class="text-ink-soft flex items-baseline gap-2 text-xs">
						<h2 id="tasks-group-waiting" class="font-bold tracking-[0.06em] uppercase">
							{app.t('app:draft_waiting')}
						</h2>
						<span class="font-semibold">{waitingNew.length}</span>
					</div>
					<ul
						class="bg-surface divide-line grid grid-cols-[minmax(0,1fr)] divide-y rounded-[var(--r-card)] shadow-[inset_0_0_0_1px_var(--line)]"
					>
						{#each waitingNew as change, i (change.draftId ?? i)}
							<li>
								<AwaitingRow {change} detail={dueOf(change.input as WaitingTaskDue)} />
							</li>
						{/each}
					</ul>
				</section>
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
	{approval}
	readFirst={reading}
	danger={mayDelete ? deleteButton : undefined}
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
			<TaskForm bind:value={form} {errors} saved={editingId !== 'new'} />
			{#if saveError}<p class="text-attention text-sm font-semibold" role="alert">
					{saveError}
				</p>{/if}
			<button type="submit" class="sr-only" tabindex="-1" aria-hidden="true">{t('save')}</button>
		</form>
	{/if}
</SidePanel>

<RepeatScope open={asking} words={scopeWords} onpick={pick} onclose={() => (asking = false)} />
