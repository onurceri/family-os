<script lang="ts">
	import { unwrap } from '@famos/api-client';
	import { untrack } from 'svelte';
	import { Button } from '@famos/ui/button';
	import { Dialog, IconButton, Notice, openPath, Section, SidePanel } from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { ChevronRight, Plus, X } from '@lucide/svelte';
	import { api } from './api.js';
	import { useChores } from './i18n.js';
	import {
		formatTimes,
		mayAddTime,
		nextTime,
		type ReminderMine,
		timesProblem,
	} from './reminder-times.js';

	/**
	 * The daily reminder of open chores: the family's times (a time per row, up to four, saved
	 * together, for those who may set them; plain text for everyone else), and whether it reaches
	 * the viewer, with a way to their notification settings, where it is switched on or off.
	 */
	let {
		open,
		onclose,
		savedTimes,
		mayEdit,
		mine,
		onsaved,
	}: {
		open: boolean;
		onclose: () => void;
		/** The family's times as last read; null when they could not be read. */
		savedTimes: readonly string[] | null;
		mayEdit: boolean;
		/** Whether it reaches the viewer; null when they get no notifications at all. */
		mine: ReminderMine | null;
		onsaved: (times: string[]) => void;
	} = $props();
	const { app, t } = useChores();

	/** The viewer's own switches for this reminder, in their notification settings. */
	const SETTINGS_HREF = '/settings/notifications#kind-chores.leftToday';

	let times = $state<string[]>([]);
	let baseline = $state('');
	let saving = $state(false);
	let showErrors = $state(false);
	let leaving = $state(false);
	const problem = $derived(showErrors ? timesProblem(times) : null);
	const dirty = $derived(open && mayEdit && JSON.stringify(times) !== baseline);
	const loadError = $derived(savedTimes === null);
	const id = $props.id();

	// Each opening starts from the saved times, and so does a later read of them (the times arriving
	// after a link opened the panel, or read again when the window regains focus), unless the form
	// already holds changes: those are kept.
	let started = false;
	$effect(() => {
		if (!open) {
			started = false;
			return;
		}
		const saved = savedTimes;
		untrack(() => {
			if (started && JSON.stringify(times) !== baseline) return;
			showErrors = false;
			const start = [...(saved ?? [])];
			times = start;
			baseline = JSON.stringify(start);
			started = true;
		});
	});

	async function save(event: SubmitEvent) {
		event.preventDefault();
		showErrors = true;
		if (timesProblem(times)) return;
		saving = true;
		try {
			const saved = unwrap(
				await api.POST('/api/v1/actions/chores.setLeftTodayTimes', { body: { times } }),
			);
			app.toast(t('reminder_times_saved'));
			baseline = JSON.stringify(times);
			onsaved(saved.status === 'applied' ? saved.output.leftTodayTimes : times);
			onclose();
		} catch {
			app.toast(t('error'));
		} finally {
			saving = false;
		}
	}
	let formEl = $state<HTMLFormElement>();

	// Leaving for the notification settings would lose times typed here: ask first.
	function openSettings(event: MouseEvent) {
		event.preventDefault();
		if (dirty) leaving = true;
		else openPath(SETTINGS_HREF);
	}
	function discardAndLeave() {
		leaving = false;
		openPath(SETTINGS_HREF);
	}

	const discard = $derived({
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	});
</script>

{#snippet timeList()}
	<ul class="grid gap-2">
		{#each times as _, i (i)}
			<li class="flex items-center gap-2">
				<Label for={`${id}-${i}`} class="sr-only">{t('reminder_time_n', { n: i + 1 })}</Label>
				<Input
					id={`${id}-${i}`}
					type="time"
					class="w-36"
					bind:value={times[i]}
					aria-invalid={problem !== null}
				/>
				{#if times.length > 1}
					<IconButton
						label={t('reminder_time_remove', { n: i + 1 })}
						variant="ghost"
						onclick={() => (times = times.filter((_, j) => j !== i))}
					>
						<X class="size-4" />
					</IconButton>
				{/if}
			</li>
		{/each}
	</ul>
	{#if problem}
		<p class="text-attention text-sm" role="alert">{t(`reminder_times_${problem}`)}</p>
	{/if}
	{#if mayAddTime(times)}
		<div>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				onclick={() => (times = [...times, nextTime(times)])}
				><Plus class="size-4" />{t('reminder_time_add')}</Button
			>
		</div>
	{/if}
{/snippet}

{#snippet forYou()}
	{#if mine}
		<Section label={t('reminder_you_label')} level={3}>
			<Notice>
				<span class="grid justify-items-start gap-2.5">
					<span
						>{mine === 'on'
							? t('reminder_you_on')
							: mine === 'off'
								? t('reminder_you_off')
								: t('reminder_you_no_channel')}</span
					>
					<Button variant="outline" size="sm" href={SETTINGS_HREF} onclick={openSettings}
						>{t('reminder_open_settings')}<ChevronRight class="size-3.5" /></Button
					>
				</span>
			</Notice>
		</Section>
	{/if}
{/snippet}

<SidePanel
	{open}
	title={t('reminder_times')}
	{onclose}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={t('save')}
	saveDisabled={saving || loadError}
	onsave={mayEdit ? () => formEl?.requestSubmit() : undefined}
	{dirty}
	{discard}
>
	<div class="grid gap-6">
		<p class="text-ink-soft text-[0.9375rem]">{t('reminder_times_hint')}</p>
		{#if loadError}
			<p class="text-attention font-semibold" role="alert">{t('error')}</p>
		{:else if mayEdit}
			<form bind:this={formEl} onsubmit={save} novalidate>
				<Section label={t('reminder_times_label')} level={3}>
					{@render timeList()}
				</Section>
			</form>
		{:else}
			<Section label={t('reminder_times_label')} level={3}>
				<div class="grid gap-1">
					<p class="font-semibold">
						{formatTimes(savedTimes ?? [], app.dateLocale(), app.hourCycle())}
					</p>
					<p class="text-ink-soft text-[0.8125rem]">{t('reminder_times_readonly')}</p>
				</div>
			</Section>
		{/if}
		{@render forYou()}
	</div>
</SidePanel>

<Dialog
	open={leaving}
	title={discard.title}
	description={discard.description}
	onclose={() => (leaving = false)}
>
	{#snippet actions()}
		<Button variant="ghost" data-autofocus onclick={() => (leaving = false)}>{discard.keep}</Button>
		<Button variant="danger" onclick={discardAndLeave}>{discard.discard}</Button>
	{/snippet}
</Dialog>
