<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { isApiError, unwrap } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import {
		Card,
		Dialog,
		EmptyLine,
		type MenuItem,
		Notice,
		Page,
		PageHeader,
		Row,
		Section,
		SwitchRow,
	} from '@famos/ui/famos';
	import { ChevronRight, CircleCheck, Info, RotateCcw, Trash2, Undo2 } from '@lucide/svelte';
	import { api } from '#lib/api.js';
	import { contributions } from '#lib/extensions.js';
	import { getLocale, t, tDynamic } from '#lib/i18n.svelte.js';
	import { onEvent } from '#lib/realtime.js';
	import { readBoot } from '#lib/restart.js';
	import RowMenu from '#lib/RowMenu.svelte';
	import { session } from '#lib/session.svelte.js';
	import { toasts } from '#lib/toast.svelte.js';
	import {
		descriptionOf,
		type Entry,
		type ExtensionList,
		nameOf,
		neededBy,
		sections,
	} from './entries.js';
	import ExtensionPanel from './ExtensionPanel.svelte';
	import Restarting from './Restarting.svelte';

	/**
	 * Extensions: what the family has installed, each with its switch (on or off for everyone, at
	 * once) and a menu to uninstall it; what can be installed, each opening its details with what it
	 * reaches and Install. Installing and uninstalling take effect when the server restarts, which
	 * is then the page's one action. Only admins manage this (the capability is critical).
	 */
	let list = $state<ExtensionList | null>(null);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let panelError = $state<string | null>(null);
	let uninstalling = $state<Entry | null>(null);
	let restarting = $state<{ before: string | null } | null>(null);

	const entries = $derived(list?.extensions ?? []);
	const texts = (entry: Entry) => {
		const web = contributions.extension(entry.id);
		return {
			language: getLocale(),
			loaded: web
				? {
						name: web.labelKey ? tDynamic(web.labelKey) : undefined,
						description: web.descriptionKey ? tDynamic(web.descriptionKey) : undefined,
					}
				: undefined,
		};
	};
	const name = (entry: Entry) => nameOf(entry, texts(entry));
	const description = (entry: Entry) => descriptionOf(entry, texts(entry));
	const grouped = $derived(sections(entries, name));

	// The details panel lives in the address (?open=<id>), so reload and Back work.
	const here = $derived(page.url.pathname);
	const openId = $derived(page.url.searchParams.get('open'));
	const opened = $derived(entries.find((e) => e.id === openId) ?? null);
	const openPanel = (entry: Entry) => {
		panelError = null;
		void goto(`${here}?open=${encodeURIComponent(entry.id)}`, { reset: false });
	};
	const closePanel = () => void goto(here, { replace: true, reset: false });

	async function load() {
		list = (await api.GET('/api/v1/core/extensions')).data ?? null;
	}

	/** The server's start id when the page opened, so a restart asked elsewhere is noticed. */
	let bootAtOpen: string | null = null;
	$effect(() => {
		void readBoot().then((boot) => (bootAtOpen = boot));
	});

	$effect(() => {
		if (session.status === 'ready' && !session.can('core.extensions.manage'))
			void goto('/', { replace: true });
	});
	$effect(() => {
		if (!session.can('core.extensions.manage')) return;
		void load();
		const offChanged = onEvent('core.extensions.', () => void load());
		const offFeatures = onEvent('core.features.', () => void load());
		// Another admin pressed Restart now: this page waits for the server with them.
		const offRestart = onEvent('core.restart.requested', () => {
			if (!restarting) restarting = { before: bootAtOpen };
		});
		return () => {
			offChanged();
			offFeatures();
			offRestart();
		};
	});

	/** What the server said, in words: the reasons it gives for a refusal, else the generic one. */
	function explain(failure: unknown): string {
		if (!isApiError(failure)) return t('error_generic');
		const details = (failure.details ?? {}) as {
			reason?: string;
			extensionId?: string;
			neededBy?: string[];
		};
		const nameFor = (id: string) => {
			const found = entries.find((e) => e.id === id);
			return found ? name(found) : id;
		};
		if (details.reason === 'missing_dependency' && details.extensionId)
			return t('extensions_error_missing', { name: nameFor(details.extensionId) });
		if (details.reason === 'needed_by' && details.neededBy)
			return t('extensions_uninstall_needed', {
				names: details.neededBy.map(nameFor).join(', '),
			});
		return t('error_generic');
	}

	async function toggle(entry: Entry, enabled: boolean) {
		error = null;
		try {
			unwrap(
				await api.POST('/api/v1/actions/core.setFeatureEnabled', {
					body: { extensionId: entry.id, enabled },
				}),
			);
			toasts.show(enabled ? t('extensions_turned_on') : t('extensions_turned_off'));
			await Promise.all([load(), session.refresh()]);
		} catch {
			error = t('error_generic');
			await load();
		}
	}

	async function install(
		entry: Entry,
		toast = t('extensions_installed_toast', { name: name(entry) }),
	) {
		busy = true;
		panelError = null;
		error = null;
		try {
			unwrap(
				await api.POST('/api/v1/actions/core.installExtension', {
					body: { extensionId: entry.id },
				}),
			);
			if (opened) closePanel();
			toasts.show(toast);
		} catch (failure) {
			if (opened) panelError = explain(failure);
			else error = explain(failure);
		} finally {
			busy = false;
			await load();
		}
	}

	async function uninstall(entry: Entry) {
		uninstalling = null;
		error = null;
		try {
			unwrap(
				await api.POST('/api/v1/actions/core.uninstallExtension', {
					body: { extensionId: entry.id },
				}),
			);
			toasts.show(t('extensions_uninstalled_toast', { name: name(entry) }));
		} catch (failure) {
			error = explain(failure);
		} finally {
			await load();
		}
	}

	async function restart() {
		error = null;
		const before = await readBoot();
		try {
			unwrap(await api.POST('/api/v1/actions/core.restartServer', { body: {} }));
		} catch (failure) {
			// The server may stop before its answer arrives; only a refusal it sent is an error.
			if (isApiError(failure) && failure.status >= 400 && failure.status < 500) {
				error = t('error_generic');
				return;
			}
		}
		restarting = { before };
	}

	function menu(entry: Entry): MenuItem[] {
		const details: MenuItem = {
			id: 'details',
			label: t('extensions_details'),
			icon: infoIcon,
			onselect: () => openPanel(entry),
		};
		const items: MenuItem[] = [details];
		// A failed start is tried again at the next restart; a refused version stays refused.
		if (entry.status === 'failed')
			items.push({
				id: 'retry',
				label: t('extensions_try_again'),
				icon: retryIcon,
				onselect: () => void install(entry, t('extensions_installed_toast', { name: name(entry) })),
			});
		if (entry.status === 'pending_uninstall')
			items.push({
				id: 'keep',
				label: t('extensions_keep'),
				icon: keepIcon,
				onselect: () => void install(entry, t('extensions_kept_toast', { name: name(entry) })),
			});
		else if (!entry.always)
			items.push({
				id: 'uninstall',
				label: t('extensions_uninstall'),
				icon: uninstallIcon,
				danger: true,
				onselect: () => (uninstalling = entry),
			});
		return items;
	}

	/** The row's second line: its state while it waits or is left out, else what it is for. */
	function meta(entry: Entry): string {
		switch (entry.status) {
			case 'pending_install':
				return t('extensions_status_pending_install');
			case 'pending_uninstall':
				return t('extensions_status_pending_uninstall');
			case 'refused':
				return t('extensions_status_refused');
			case 'failed':
				return t('extensions_status_failed');
			default:
				return [description(entry), t('extensions_version', { version: entry.version })]
					.filter(Boolean)
					.join(' · ');
		}
	}

	const blockers = $derived(uninstalling ? neededBy(uninstalling, entries) : []);
</script>

{#snippet infoIcon()}<Info class="size-4" aria-hidden="true" />{/snippet}
{#snippet retryIcon()}<RotateCcw class="size-4" aria-hidden="true" />{/snippet}
{#snippet keepIcon()}<Undo2 class="size-4" aria-hidden="true" />{/snippet}
{#snippet uninstallIcon()}<Trash2 class="size-4" aria-hidden="true" />{/snippet}

<Page template="settings">
	<PageHeader title={t('extensions_title')} subtitle={t('extensions_intro')}>
		{#snippet actions()}
			{#if list?.restartNeeded}
				<Button variant="primary" onclick={restart} data-testid="restart-now"
					><RotateCcw aria-hidden="true" />{t('extensions_restart')}</Button
				>
			{/if}
		{/snippet}
	</PageHeader>

	{#if list}
		<div class="grid gap-7">
			{#if list.restartNeeded}
				<Notice>{t('extensions_restart_needed')}</Notice>
			{/if}
			{#if error}<Notice tone="alert">{error}</Notice>{/if}

			<Section label={t('extensions_installed')} count={grouped.installed.length}>
				<Card rows data-testid="installed-extensions">
					{#each grouped.installed as entry (entry.id)}
						{#if entry.status === 'loaded'}
							<SwitchRow
								id="extension-{entry.id}"
								label={name(entry)}
								hint={meta(entry)}
								checked={entry.enabled}
								disabled={!session.can('core.features.manage')}
								onchange={(enabled) => toggle(entry, enabled)}
							>
								{#snippet end()}<RowMenu name={name(entry)} items={menu(entry)} />{/snippet}
							</SwitchRow>
						{:else}
							<Row wrap title={name(entry)} meta={meta(entry)} data-testid="extension-{entry.id}">
								<!-- The second line says its state (waiting, or left out and why); said once. -->
								{#snippet trail()}<RowMenu name={name(entry)} items={menu(entry)} />{/snippet}
							</Row>
						{/if}
					{/each}
				</Card>
			</Section>

			<Section label={t('extensions_available')} count={grouped.available.length}>
				{#if grouped.available.length > 0}
					<Card rows data-testid="available-extensions">
						{#each grouped.available as entry (entry.id)}
							<Row
								title={name(entry)}
								meta={description(entry)}
								onclick={() => openPanel(entry)}
								aria-label={name(entry)}
							>
								{#snippet trail()}
									<ChevronRight class="text-ink-soft size-4" aria-hidden="true" />
								{/snippet}
							</Row>
						{/each}
					</Card>
				{:else}
					<EmptyLine text={t('extensions_available_none')}>
						{#snippet icon()}<CircleCheck aria-hidden="true" />{/snippet}
					</EmptyLine>
				{/if}
			</Section>

			<p class="text-ink-soft max-w-prose px-1 text-[13px]">{t('extensions_data_kept')}</p>
		</div>
	{/if}

	<ExtensionPanel
		entry={opened}
		list={entries}
		{name}
		{description}
		{busy}
		error={panelError}
		oninstall={(entry) => void install(entry)}
		onclose={closePanel}
	/>

	<Dialog
		open={uninstalling !== null}
		title={uninstalling ? t('extensions_uninstall_title', { name: name(uninstalling) }) : ''}
		description={uninstalling
			? blockers.length > 0
				? t('extensions_uninstall_needed', { names: blockers.map(name).join(', ') })
				: t('extensions_uninstall_hint', { name: name(uninstalling) })
			: undefined}
		onclose={() => (uninstalling = null)}
	>
		{#snippet actions()}
			<Button variant="ghost" data-autofocus onclick={() => (uninstalling = null)}
				>{t('cancel')}</Button
			>
			{#if uninstalling && blockers.length === 0}
				{@const target = uninstalling}
				<Button variant="danger" data-armed="true" onclick={() => void uninstall(target)}
					>{t('extensions_uninstall')}</Button
				>
			{/if}
		{/snippet}
	</Dialog>
</Page>

{#if restarting}<Restarting before={restarting.before} />{/if}
