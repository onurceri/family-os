<script lang="ts">
	import { Button } from '@famos/ui/button';
	import {
		Dialog,
		focusFirstInvalid,
		type MenuItem,
		Page,
		PageHeader,
		RecordHeader,
		SidePanel,
		wide,
		editLabel,
	} from '@famos/ui/famos';
	import Slot from '@famos/ui/slot';
	import { ArrowLeft, Archive, Pencil, Zap } from '@lucide/svelte';
	import {
		HOME_AUDIENCE,
		type Home,
		SERVICE_KIND,
		type Service,
		serviceUrl,
	} from '../contract/index.js';
	import { archiveService, loadHome, loadService, type Outcome, updateService } from './data.js';
	import {
		emptyService,
		fromService,
		type ServiceFormValue,
		toServiceFields,
		validateService,
	} from './form.js';
	import { useHome } from './i18n.js';
	import { openPath } from './nav.js';
	import RecordMenu from './RecordMenu.svelte';
	import ServiceForm from './ServiceForm.svelte';

	/**
	 * One utility or subscription (`/home/services/:id`): provider, account and billing day, then
	 * what needs doing (a contract ending, say), its papers (bills, contracts) and its costs.
	 */
	let { params }: { params: Record<string, string> } = $props();
	const { app, t } = useHome();

	const serviceId = $derived(params.id ?? '');
	let service = $state<Service | null>(null);
	let home = $state<Home | null>(null);
	let missing = $state(false);
	let loadError = $state(false);
	async function load() {
		// A slower answer for the record chosen before must not replace this one.
		const id = serviceId;
		try {
			const loaded = await loadService(id);
			const loadedHome = await loadHome(loaded.homeId).catch(() => null);
			if (id !== serviceId) return;
			service = loaded;
			home = loadedHome;
			missing = false;
			loadError = false;
		} catch (error) {
			if (id !== serviceId) return;
			service = null;
			const status = (error as { status?: number }).status;
			missing = status === 404 || status === 400;
			loadError = !missing;
		}
	}
	$effect(() => {
		void serviceId;
		void load();
		return app.onEvent('home.', () => void load());
	});

	// Also for people who may only suggest a change: theirs waits for approval.
	const mayEdit = $derived(app.access('home.updateService') !== 'no');
	// "Suggest a change" when the change would wait for approval.
	const editText = $derived(editLabel(app, 'home.updateService', t('edit')));
	const mayArchive = $derived(app.access('home.archiveService') !== 'no');
	const report = (outcome: Outcome, message: string) => {
		if (outcome === 'drafted') app.sentForApproval();
		else app.toast(message);
	};

	// Editing: a panel (a sheet on phones), reflected as `?edit=1`.
	const editing = $derived(mayEdit && app.query().get('edit') === '1');
	const setEditing = (on: boolean) => app.setQuery({ edit: on ? '1' : null }, { replace: !on });
	let form = $state<ServiceFormValue>(emptyService());
	let baseline = $state('');
	let showErrors = $state(false);
	let busy = $state(false);
	let formEl = $state<HTMLFormElement>();
	let formReady = false;
	const errors = $derived(showErrors ? validateService(form) : {});
	const dirty = $derived(editing && JSON.stringify(form) !== baseline);
	$effect(() => {
		if (!editing) {
			formReady = false;
			return;
		}
		if (formReady || !service) return;
		form = fromService(service);
		baseline = JSON.stringify(form);
		showErrors = false;
		formReady = true;
	});
	async function save(event: SubmitEvent) {
		event.preventDefault();
		showErrors = true;
		if (!service || Object.keys(validateService(form)).length) {
			void focusFirstInvalid(event.currentTarget);
			return;
		}
		busy = true;
		try {
			report(await updateService(service.id, toServiceFields(form)), t('saved'));
			setEditing(false);
			await load();
		} catch {
			app.toast(t('error'));
		} finally {
			busy = false;
		}
	}

	let archiving = $state(false);
	async function archive() {
		archiving = false;
		if (!service) return;
		try {
			const outcome = await archiveService(service.id);
			report(outcome, t('service_archived'));
			if (outcome === 'applied') openPath(home ? `/home/${home.id}` : '/home');
		} catch {
			app.toast(t('error'));
		}
	}
	const menu = $derived<MenuItem[]>([
		...(mayEdit
			? [{ id: 'edit', label: editText, icon: pencil, onselect: () => setEditing(true) }]
			: []),
		...(mayArchive
			? [
					{
						id: 'archive',
						label: t('archive_service'),
						icon: box,
						danger: true,
						onselect: () => (archiving = true),
					},
				]
			: []),
	]);

	const facts = $derived(
		service
			? [
					t(`service_kind_${service.kind}`),
					service.accountNumber ? `${t('field_account_number')} ${service.accountNumber}` : null,
					service.dueDay ? `${t('field_due_day')} ${service.dueDay}` : null,
				]
			: [],
	);
</script>

{#snippet pencil()}<Pencil class="size-4" />{/snippet}
{#snippet box()}<Archive class="size-4" />{/snippet}

{#snippet actionButtons()}
	{#if service}
		{#if mayEdit}
			<Button variant="outline" onclick={() => setEditing(true)}
				><Pencil class="size-4" aria-hidden="true" />{editText}</Button
			>
		{/if}
		{#if menu.length > 0}
			<RecordMenu
				name={service.provider}
				label={t('options_for', { name: service.provider })}
				cancelLabel={t('cancel')}
				items={menu}
			/>
		{/if}
	{/if}
{/snippet}

<Page template="record">
	<div class="mb-3 flex items-center gap-2">
		<Button variant="ghost" size="sm" href={home ? `/home/${home.id}` : '/home'} class="-ms-2"
			><ArrowLeft class="size-4" aria-hidden="true" />{home ? home.name : t('back')}</Button
		>
		{#if !wide.current}
			<span class="ms-auto flex items-center gap-2">{@render actionButtons()}</span>
		{/if}
	</div>

	{#if loadError}
		<p class="text-attention font-semibold" role="alert">{t('error')}</p>
	{:else if missing}
		<PageHeader title={t('service_not_found')} />
	{:else if service}
		<RecordHeader
			name={service.provider}
			recordId={service.id}
			{facts}
			actions={wide.current ? actionButtons : undefined}
		>
			{#snippet icon()}<Zap />{/snippet}
		</RecordHeader>

		<div class="grid gap-7">
			{#if service.notes}<p class="text-ink-soft max-w-prose break-words">{service.notes}</p>{/if}

			<Slot
				name="record.section"
				props={{
					recordId: service.id,
					recordKind: SERVICE_KIND,
					recordName: service.provider,
					recordUrl: serviceUrl(service.id),
					audience: HOME_AUDIENCE,
				}}
			/>
		</div>
	{/if}
</Page>

<SidePanel
	approval={app.approval('home.updateService')}
	open={editing}
	title={t('service_form_title')}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={t('save')}
	saveDisabled={busy}
	onsave={() => formEl?.requestSubmit()}
	{dirty}
	discard={{
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	}}
	onclose={() => setEditing(false)}
>
	<form bind:this={formEl} onsubmit={save} aria-label={t('service_form_title')}>
		<ServiceForm bind:value={form} {errors} idPrefix="edit-service" />
	</form>
</SidePanel>

<Dialog
	open={archiving}
	title={t('archive_title', { name: service?.provider ?? '' })}
	description={t('archive_service_hint')}
	onclose={() => (archiving = false)}
>
	{#snippet actions()}
		<Button variant="ghost" data-autofocus onclick={() => (archiving = false)}>{t('cancel')}</Button
		>
		<Button variant="danger" data-armed="true" onclick={archive}>{t('archive_do')}</Button>
	{/snippet}
</Dialog>
