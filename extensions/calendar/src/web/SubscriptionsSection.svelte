<script lang="ts">
	import { Button } from '@famos/ui/button';
	import {
		Card,
		ConfirmButton,
		FIELD_REASON,
		FieldError,
		fieldAria,
		focusFirstInvalid,
		MemberChips,
		Notice,
		Row,
		Section,
		SidePanel,
		SwitchRow,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { ChevronRight, Plus, RefreshCw } from '@lucide/svelte';
	import { onDestroy, onMount } from 'svelte';
	import { SUBSCRIPTION_COLORS, type Subscription } from '../contract/index.js';
	import ColorChoice from './ColorChoice.svelte';
	import {
		addSubscription,
		loadSubscriptions,
		refreshSubscription,
		removeSubscription,
		updateSubscription,
	} from './data.js';
	import { useCalendar } from './i18n.js';
	import LoadFailed from './LoadFailed.svelte';
	import { readList } from './reload-list.js';

	/**
	 * "Calendar subscriptions": read-only external calendars in. Managers only. Adding
	 * and editing happen in one panel (a sheet on phones).
	 */
	const { app, t } = useCalendar();

	let subs = $state<Subscription[]>([]);
	let loaded = $state(false);

	/** The open panel: a new subscription (`id: null`) or one being edited. */
	let panel = $state<{ id: string | null; host: string } | null>(null);
	let name = $state('');
	let url = $state('');
	let color = $state<string>(SUBSCRIPTION_COLORS[0] as string);
	let memberIds = $state<string[]>([]);
	let reminders = $state(false);
	let allowLocal = $state(false);
	let busy = $state(false);
	let failed = $state(false);
	let formEl = $state<HTMLFormElement>();

	/** A read that failed keeps the list on screen and is never taken for an empty one. */
	let loadFailed = $state(false);
	async function load() {
		const read = await readList(loadSubscriptions, subs);
		subs = read.list;
		loadFailed = !read.ok;
		if (read.ok) loaded = true;
	}
	onMount(() => void load());
	// A refresh finishes in the background; the list follows.
	let off: (() => void) | undefined;
	onMount(() => {
		off = app.onEvent('calendar.subscription', () => void load());
	});
	onDestroy(() => off?.());

	function startAdd() {
		name = url = '';
		color = SUBSCRIPTION_COLORS[subs.length % SUBSCRIPTION_COLORS.length] as string;
		memberIds = [];
		reminders = allowLocal = false;
		failed = false;
		showErrors = false;
		panel = { id: null, host: '' };
	}

	// Editing: the stored address is never shown; an empty field keeps it.
	function startEdit(sub: Subscription) {
		name = sub.name;
		url = '';
		color = sub.color;
		memberIds = [...sub.memberIds];
		reminders = sub.reminders;
		allowLocal = sub.allowLocal;
		failed = false;
		showErrors = false;
		panel = { id: sub.id, host: sub.host };
	}

	const editing = $derived(panel?.id ? subs.find((s) => s.id === panel?.id) : undefined);

	// Why Save is refused, shown after the first press; the button itself stays pressable.
	let showErrors = $state(false);
	const errors = $derived({
		...(name.trim() ? {} : { name: FIELD_REASON.name }),
		...(!panel?.id && !url.trim() ? { url: FIELD_REASON.required } : {}),
	} as Record<string, string>);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!panel) return;
		showErrors = true;
		if (Object.keys(errors).length) {
			void focusFirstInvalid(formEl);
			return;
		}
		busy = true;
		failed = false;
		try {
			if (panel.id) {
				const address = url.trim();
				await updateSubscription({
					id: panel.id,
					name: name.trim(),
					...(address ? { url: address } : {}),
					color,
					memberIds,
					reminders,
					allowLocal,
				});
				app.toast(t('sub_saved'));
			} else {
				await addSubscription({
					name: name.trim(),
					url: url.trim(),
					color,
					memberIds,
					reminders,
					allowLocal,
				});
				app.toast(t('sub_added'));
			}
			panel = null;
			await load();
		} catch {
			failed = true;
		} finally {
			busy = false;
		}
	}

	async function refresh(sub: Subscription) {
		try {
			await refreshSubscription(sub.id);
			app.toast(t('sub_refresh_requested'));
		} catch {
			app.toast(t('error'));
		}
	}

	async function remove(sub: Subscription) {
		try {
			await removeSubscription(sub.id);
			app.toast(t('sub_removed'));
			panel = null;
			await load();
		} catch {
			app.toast(t('error'));
		}
	}

	const when = (ms: number) =>
		new Intl.DateTimeFormat(app.dateLocale(), {
			day: 'numeric',
			month: 'short',
			hour: '2-digit',
			minute: '2-digit',
			timeZone: app.timeZone(),
		}).format(ms);

	function errorText(code: string): string {
		if (code.startsWith('http_')) return t('sub_error_http', { status: code.slice(5) });
		switch (code) {
			case 'too_large':
				return t('sub_error_too_large');
			case 'not_calendar':
				return t('sub_error_not_calendar');
			case 'blocked_address':
				return t('sub_error_blocked_address');
			case 'bad_url':
				return t('sub_error_bad_url');
			default:
				return t('sub_error_unreachable');
		}
	}
</script>

<Section label={t('subs_title')} count={loaded ? subs.length : undefined}>
	{#snippet actions()}
		<Button variant="ghost" size="sm" onclick={startAdd}
			><Plus class="size-4" aria-hidden="true" />{t('sub_add')}</Button
		>
	{/snippet}
	<p class="text-ink-soft max-w-prose px-1 text-[13px]">{t('subs_intro')} {t('subs_warning')}</p>
	{#if loaded}
		{#if subs.length > 0}
			<Card rows>
				{#each subs as sub (sub.id)}
					<Row
						title={sub.name}
						meta="{sub.host} · {t('sub_events', { count: sub.eventCount })} · {sub.lastFetchedAt
							? t('sub_updated', { when: when(sub.lastFetchedAt) })
							: t('sub_never')}"
						onclick={() => startEdit(sub)}
						aria-label={sub.name}
					>
						{#snippet lead()}
							<span
								class="block size-3 rounded-full"
								style:background-color={sub.color}
								aria-hidden="true"
							></span>
						{/snippet}
						{#snippet trail()}<ChevronRight
								class="text-ink-soft size-4"
								aria-hidden="true"
							/>{/snippet}
					</Row>
					{#if sub.lastError}
						<div class="px-3 py-2">
							<Notice tone="alert">{errorText(sub.lastError)}</Notice>
						</div>
					{/if}
				{/each}
			</Card>
		{:else}
			<Card variant="quiet" pad><p class="text-ink-soft text-sm">{t('subs_none')}</p></Card>
		{/if}
	{/if}
	{#if loadFailed}<LoadFailed onretry={load} />{/if}
</Section>

<SidePanel
	open={panel !== null}
	title={panel?.id ? t('sub_edit_title', { name: editing?.name ?? name }) : t('sub_add')}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={panel?.id ? t('sub_save') : t('sub_add')}
	saveDisabled={busy}
	onsave={() => formEl?.requestSubmit()}
	onclose={() => (panel = null)}
	dirty={panel !== null && (name !== (editing?.name ?? '') || url !== '')}
	discard={{
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	}}
>
	{#snippet danger()}
		{#if editing}
			<ConfirmButton
				label={t('sub_remove')}
				confirmLabel={t('sub_remove_confirm')}
				onconfirm={() => remove(editing)}
			/>
		{/if}
	{/snippet}
	<form
		class="grid gap-5"
		bind:this={formEl}
		onsubmit={submit}
		aria-label={panel?.id ? t('sub_edit_title', { name: editing?.name ?? name }) : t('sub_add')}
	>
		<div class="grid gap-1.5">
			<Label for="sub-name">{t('sub_name')}</Label>
			<Input
				id="sub-name"
				bind:value={name}
				maxlength={80}
				placeholder={t('sub_name_placeholder')}
				{...fieldAria(showErrors ? errors.name : undefined, 'sub-name')}
			/>
			<FieldError for="sub-name" error={showErrors ? errors.name : undefined} />
		</div>
		<div class="grid gap-1.5">
			<Label for="sub-url">{panel?.id ? t('sub_new_url') : t('sub_url')}</Label>
			<Input
				id="sub-url"
				bind:value={url}
				maxlength={2000}
				inputmode="url"
				autocomplete="off"
				autocapitalize="off"
				spellcheck={false}
				placeholder="https://…"
				{...fieldAria(showErrors ? errors.url : undefined, 'sub-url')}
			/>
			<FieldError for="sub-url" error={showErrors ? errors.url : undefined} />
			<p class="text-ink-soft text-[13px]">
				{panel?.id ? t('sub_new_url_hint', { host: panel.host }) : t('sub_url_hint')}
			</p>
		</div>
		<ColorChoice bind:value={color} name="sub-color" legend={t('sub_color')} />
		<div class="grid gap-2">
			<span class="text-sm font-semibold">{t('sub_members')}</span>
			<MemberChips
				members={app.members()}
				bind:selected={memberIds}
				multiple
				noneLabel={t('everyone')}
			/>
		</div>
		<Card rows>
			<SwitchRow
				id="sub-reminders"
				label={t('sub_reminders')}
				hint={t('sub_reminders_hint')}
				bind:checked={reminders}
			/>
			<SwitchRow
				id="sub-local"
				label={t('sub_allow_local')}
				hint={t('sub_allow_local_warn')}
				bind:checked={allowLocal}
			/>
		</Card>
		{#if editing}
			<Button
				type="button"
				variant="secondary"
				class="justify-self-start"
				onclick={() => refresh(editing)}><RefreshCw class="size-4" />{t('sub_refresh')}</Button
			>
		{/if}
		{#if failed}<p class="text-attention text-sm font-semibold" role="alert">{t('error')}</p>{/if}
	</form>
</SidePanel>
