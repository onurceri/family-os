<script lang="ts">
	import { todayIn } from '@famos/time';
	import { Button } from '@famos/ui/button';
	import {
		ConfirmButton,
		EmptyState,
		Fab,
		focusFirstInvalid,
		ListDetail,
		Section,
		Segmented,
		SidePanel,
	} from '@famos/ui/famos';
	import { Plus } from '@lucide/svelte';
	import { onDestroy } from 'svelte';
	import type { Chore } from '../contract/index.js';
	import ChoreForm from './ChoreForm.svelte';
	import ChoreRow from './ChoreRow.svelte';
	import {
		archiveChore,
		createChore,
		loadChores,
		markDone,
		type Outcome,
		setAssignees,
		undoDone,
		updateChore,
	} from './data.js';
	import {
		type ChoreFormValue,
		emptyChore,
		fromChore,
		type Group,
		groupOf,
		toDetails,
		validate,
	} from './form.js';
	import { useChores } from './i18n.js';
	import { hasOpenChore } from './open-chores.js';
	import { openPath } from './nav.js';

	/**
	 * The Chores page: what is due today, what is overdue and what is coming, with whose turn it is.
	 * One tap marks a chore done (with an Undo in the toast); the rotation moves the turn on.
	 */
	let { params = {} }: { params?: Record<string, string> } = $props();
	const { app, t } = useChores();
	/** The chore open in the form, from the address (`/chores/:id`). */
	const selectedId = $derived(params.id ?? '');

	let now = $state(Date.now());
	const clock = setInterval(() => (now = Date.now()), 60_000);
	onDestroy(() => clearInterval(clock));
	const today = $derived(todayIn(app.timeZone(), now));

	let chores = $state<Chore[]>([]);
	let loaded = $state(false);
	let loadError = $state(false);
	async function load() {
		try {
			chores = await loadChores();
			loadError = false;
		} catch {
			loadError = true;
		} finally {
			loaded = true;
		}
	}
	$effect(() => {
		void app.offline(); // load again when the connection is back
		void load();
		return app.onEvent('chores.', () => void load());
	});

	// Taps kept on this device while offline: the chore waits, marked, until they are sent.
	const waitingIds = $derived(
		new Set(
			app
				.waiting()
				.filter((w) => w.actionId === 'chores.markDone')
				.map((w) => (w.input as { id: string }).id),
		),
	);
	let waitingBefore = 0;
	$effect(() => {
		const n = app.waiting().length;
		if (n < waitingBefore) void load();
		waitingBefore = n;
	});

	const me = $derived(app.me()?.id ?? null);
	const canEdit = $derived(app.can('chores.edit'));
	const canUse = $derived(app.can('chores.use'));
	// Opening and adding a chore is also for people who may only suggest: theirs waits for approval.
	const mayChange = $derived(app.mayChange('chores.edit'));
	const canDo = (c: Chore) => canEdit || (canUse && (c.assigneeId === null || c.assigneeId === me));

	let onlyMine = $state(false);
	const visible = $derived(
		onlyMine ? chores.filter((c) => c.assigneeId === null || c.assigneeId === me) : chores,
	);
	const groups: Group[] = ['overdue', 'today', 'upcoming', 'done'];
	const inGroup = (g: Group) => visible.filter((c) => groupOf(c, today) === g);

	let busy = $state<Record<string, true>>({});
	async function tick(chore: Chore) {
		busy[chore.id] = true;
		try {
			const result = await markDone(app, chore, t('label_done', { title: chore.title }));
			if (result === 'queued') {
				app.toast(t('queued_toast'));
				return;
			}
			if (!result?.completion) {
				await load();
				return;
			}
			const completionId = result.completion.id;
			app.toast(t('done_toast', { title: chore.title }), {
				label: t('undo'),
				run: () => {
					void undoDone(app, completionId, t('label_undo')).then(
						() => load(),
						() => app.toast(t('undo_failed')),
					);
				},
			});
		} catch {
			app.toast(t('error'));
		} finally {
			delete busy[chore.id];
		}
	}

	// The form: adding, or changing one chore.
	let editing = $state<{ id: string | null; original: Chore | null } | null>(null);
	let form = $state<ChoreFormValue>(emptyChore(todayIn('UTC', Date.now())));
	let showErrors = $state(false);
	let saving = $state(false);
	const errors = $derived(showErrors ? validate(form) : {});
	// What the form held when it opened, to tell whether closing it would lose something.
	let baseline = $state('');
	const dirty = $derived(editing !== null && JSON.stringify(form) !== baseline);
	let formEl = $state<HTMLFormElement>();
	const empty = $derived(loaded && !loadError && chores.length === 0);
	function openNew() {
		const fresh = emptyChore(today);
		form = fresh;
		baseline = JSON.stringify(fresh);
		showErrors = false;
		editing = { id: null, original: null };
	}
	// Opening a chore changes the address; the form follows it.
	function openEdit(chore: Chore) {
		if (mayChange) openPath(`/chores/${chore.id}`);
	}
	$effect(() => {
		const id = selectedId;
		// Back to the plain list (same mounted page): close the form of the chore that was open.
		if (!id && editing?.id) editing = null;
		if (!id || !loaded || !mayChange || editing?.id === id) return;
		const chore = chores.find((c) => c.id === id);
		if (!chore) return;
		const loadedForm = fromChore(chore);
		form = loadedForm;
		baseline = JSON.stringify(loadedForm);
		showErrors = false;
		editing = { id, original: chore };
	});
	function closeForm() {
		editing = null;
		if (selectedId) openPath('/chores');
	}
	const report = (outcome: Outcome, message: string) => {
		if (outcome === 'drafted') app.sentForApproval();
		else app.toast(message);
	};

	async function save(event: SubmitEvent) {
		event.preventDefault();
		showErrors = true;
		if (!editing || Object.keys(validate(form)).length) {
			void focusFirstInvalid(event.currentTarget);
			return;
		}
		saving = true;
		try {
			const details = toDetails(form);
			if (editing.id && editing.original) {
				const before = editing.original.assigneeIds;
				let outcome = await updateChore({ id: editing.id, chore: details });
				if (form.assigneeIds.join() !== before.join())
					outcome = await setAssignees(editing.id, form.assigneeIds);
				report(outcome, t('saved'));
			} else {
				const { outcome } = await createChore({ ...details, assigneeIds: form.assigneeIds });
				report(outcome, t('saved'));
			}
			closeForm();
			await load();
		} catch {
			app.toast(t('error'));
		} finally {
			saving = false;
		}
	}
	/** The open chore's latest tick, when it is the viewer's own of today: they may take it back. */
	const ownTick = $derived.by(() => {
		const done = editing?.id ? chores.find((c) => c.id === editing?.id)?.lastDone : null;
		if (!done || done.memberId !== me) return null;
		return todayIn(app.timeZone(), done.doneAt) === today ? done : null;
	});
	async function takeBack(completionId: string) {
		try {
			await undoDone(app, completionId, t('label_undo'));
			await load();
		} catch {
			app.toast(t('undo_failed'));
		}
	}

	async function archive() {
		if (!editing?.id) return;
		try {
			report(await archiveChore(editing.id), t('archived'));
			closeForm();
			await load();
		} catch {
			app.toast(t('error'));
		}
	}
</script>

{#snippet add()}
	{#if mayChange && !editing}
		<Button onclick={openNew} class="max-md:hidden"
			><Plus class="size-4" />{canEdit ? t('add_chore') : t('suggest_chore')}</Button
		>
	{/if}
{/snippet}

{#snippet archiveButton()}
	<ConfirmButton label={t('archive')} confirmLabel={t('archive_confirm')} onconfirm={archive} />
{/snippet}

{#snippet formCard()}
	{#if ownTick}
		{@const done = ownTick}
		<div class="border-line mb-4 flex items-center gap-3 border-b pb-4" data-testid="own-tick">
			<p class="text-ink-soft min-w-0 flex-1 text-sm">{t('own_tick_today')}</p>
			<Button variant="secondary" size="sm" onclick={() => takeBack(done.id)}>{t('undo')}</Button>
		</div>
	{/if}
	<form bind:this={formEl} onsubmit={save} class="grid gap-4" aria-label={t('form_title')}>
		<ChoreForm bind:value={form} {errors} idPrefix="chore" />
	</form>
{/snippet}

{#snippet listBody()}
	{#if chores.length > 0}
		<div class="mb-5">
			<Segmented
				label={t('filter')}
				options={[
					{ value: 'all', label: t('filter_all') },
					{ value: 'mine', label: t('filter_mine') },
				]}
				value={onlyMine ? 'mine' : 'all'}
				onchange={(v) => (onlyMine = v === 'mine')}
			/>
		</div>
	{/if}

	{#if loadError}
		<p class="text-attention font-semibold" role="alert">{t('error')}</p>
	{:else if loaded && onlyMine && !hasOpenChore(visible)}
		<p class="text-ink-soft">{t('nothing_mine')}</p>
	{/if}

	<div class="grid gap-7">
		{#each groups as group (group)}
			{@const items = inGroup(group)}
			{#if items.length > 0}
				<Section label={t(`group_${group}`)} count={items.length}>
					<ul class="grid grid-cols-[repeat(auto-fill,minmax(min(22rem,100%),1fr))] gap-1.5">
						{#each items as chore (chore.id)}
							<li class="min-w-0">
								<ChoreRow
									{chore}
									{today}
									canDo={canDo(chore)}
									busy={chore.id in busy}
									waiting={waitingIds.has(chore.id)}
									selected={chore.id === selectedId}
									ondone={() => tick(chore)}
									onopen={mayChange ? () => openEdit(chore) : undefined}
								/>
							</li>
						{/each}
					</ul>
				</Section>
			{/if}
		{/each}
	</div>
{/snippet}

<ListDetail title={t('title')} actions={empty ? undefined : add} selected={false}>
	{#snippet list()}
		{#if empty}
			<EmptyState art="chores" title={t('empty')} hint={t('empty_hint')}>
				{#if mayChange}
					<Button onclick={openNew}
						><Plus class="size-4" />{canEdit ? t('add_chore') : t('suggest_chore')}</Button
					>
				{/if}
			</EmptyState>
		{:else}
			{@render listBody()}
		{/if}
	{/snippet}
	{#snippet detail()}{/snippet}
</ListDetail>

{#if !empty && mayChange && !editing}
	<div class="md:hidden">
		<Fab label={canEdit ? t('add_chore') : t('suggest_chore')} onclick={openNew} />
	</div>
{/if}

<!-- Adding or changing a chore opens beside the list (a full-height sheet on a phone). -->
<SidePanel
	open={editing !== null}
	title={t('form_title')}
	onclose={closeForm}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={t('save')}
	saveDisabled={saving}
	onsave={() => formEl?.requestSubmit()}
	note={app.needsApproval('chores.edit') ? app.t('app:draft_approval_note') : undefined}
	danger={editing?.id ? archiveButton : undefined}
	{dirty}
	discard={{
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	}}
>
	{@render formCard()}
</SidePanel>
