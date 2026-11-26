<script lang="ts">
	import { unwrap } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import { IconButton, SidePanel } from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { Plus, X } from '@lucide/svelte';
	import { api } from './api.js';
	import { useChores } from './i18n.js';
	import { mayAddTime, nextTime, timesProblem } from './reminder-times.js';

	/**
	 * The times of the evening count of open chores, for those who may edit chores: a panel with a
	 * time per row, up to four, saved together.
	 */
	let { open, onclose }: { open: boolean; onclose: () => void } = $props();
	const { app, t } = useChores();

	let times = $state<string[]>([]);
	let baseline = $state('');
	let saving = $state(false);
	let loadError = $state(false);
	let showErrors = $state(false);
	const problem = $derived(showErrors ? timesProblem(times) : null);
	const dirty = $derived(open && JSON.stringify(times) !== baseline);
	const id = $props.id();

	$effect(() => {
		if (!open) return;
		showErrors = false;
		loadError = false;
		void (async () => {
			try {
				const settings = unwrap(await api.GET('/api/v1/chores/settings'));
				times = [...settings.leftTodayTimes];
				baseline = JSON.stringify(times);
			} catch {
				loadError = true;
			}
		})();
	});

	async function save(event: SubmitEvent) {
		event.preventDefault();
		showErrors = true;
		if (timesProblem(times)) return;
		saving = true;
		try {
			unwrap(await api.POST('/api/v1/actions/chores.setLeftTodayTimes', { body: { times } }));
			app.toast(t('reminder_times_saved'));
			baseline = JSON.stringify(times);
			onclose();
		} catch {
			app.toast(t('error'));
		} finally {
			saving = false;
		}
	}
	let formEl = $state<HTMLFormElement>();
</script>

<SidePanel
	{open}
	title={t('reminder_times')}
	{onclose}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={t('save')}
	saveDisabled={saving || loadError}
	onsave={() => formEl?.requestSubmit()}
	{dirty}
	discard={{
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	}}
>
	<form bind:this={formEl} onsubmit={save} class="grid gap-4" novalidate>
		<p class="text-ink-soft text-sm">{t('reminder_times_hint')}</p>
		{#if loadError}
			<p class="text-attention font-semibold" role="alert">{t('error')}</p>
		{/if}
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
	</form>
</SidePanel>
