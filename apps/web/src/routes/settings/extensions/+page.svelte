<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { isApiError, unwrap } from '@famos/api-client';
	import { tick } from 'svelte';
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
	import {
		ChevronRight,
		CircleCheck,
		FileUp,
		Info,
		RotateCcw,
		Search,
		Trash2,
		Undo2,
	} from '@lucide/svelte';
	import { api } from '#lib/api.js';
	import { contributions } from '#lib/extensions.js';
	import { getLocale, t, tDynamic } from '#lib/i18n.svelte.js';
	import { family } from '#lib/family.svelte.js';
	import { dateTimeFormat } from '#lib/format.svelte.js';
	import { onEvent } from '#lib/realtime.js';
	import { readBoot } from '#lib/restart.js';
	import RowMenu from '#lib/RowMenu.svelte';
	import { session } from '#lib/session.svelte.js';
	import { toasts } from '#lib/toast.svelte.js';
	import {
		descriptionOf,
		downloadProblem,
		type Entry,
		type ExtensionList,
		type FileProblem,
		type Found,
		type FoundPackage,
		askedOf,
		fileProblem,
		foundEntry,
		nameOf,
		neededBy,
		pendingOf,
		type Staged,
		searchProblem,
		sections,
		stagedEntry,
		updateOf,
		withFound,
	} from './entries.js';
	import ExtensionPanel from './ExtensionPanel.svelte';
	import FoundPanel from './FoundPanel.svelte';
	import Restarting from './Restarting.svelte';

	/**
	 * Extensions: what can be installed first (what this server has, then what the index offers),
	 * each opening its details with what it reaches and Install; then what the family has
	 * installed, each with its switch (on or off for everyone, at once) and a menu to uninstall it. Installing and uninstalling take effect when the server restarts, which
	 * is then the page's one action. A signed package can also come from a file (the head's ⋯):
	 * the server checks it, and its details open with Install. "Look for more" (the same menu)
	 * asks the server to read the official index, only then: what it lists that this server lacks
	 * opens with Download, and a downloaded package is checked and installed like a file. Only
	 * admins manage this (the capability is critical).
	 */
	let list = $state<ExtensionList | null>(null);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let panelError = $state<string | null>(null);
	let uninstalling = $state<Entry | null>(null);
	let restarting = $state<{ before: string | null } | null>(null);
	/** The restart question, which lists what changes and who asked for each. */
	let confirmingRestart = $state(false);
	/** A package from a file the server checked, shown in the panel until it is installed. */
	let staged = $state<Staged | null>(null);
	let fileError = $state<{ text: string; detail?: string } | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);
	/** What the last look in the official index found, and the last download from it. */
	let found = $state<Found | null>(null);
	/** The found package whose details are open. */
	let foundOpen = $state<FoundPackage | null>(null);
	/** The server would not start the download (the index changed since: look again). */
	let foundError = $state<string | null>(null);

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
	const shown = $derived(withFound(grouped, found?.found ?? []));

	// The details panel lives in the address (?open=<id>), so reload and Back work.
	const here = $derived(page.url.pathname);
	const openId = $derived(page.url.searchParams.get('open'));
	const opened = $derived(entries.find((e) => e.id === openId) ?? null);
	const panelEntry = $derived(staged ? stagedEntry(staged) : opened);
	const openPanel = (entry: Entry) => {
		panelError = null;
		void goto(`${here}?open=${encodeURIComponent(entry.id)}`, { reset: false });
	};
	const closePanel = () => void goto(here, { replace: true, reset: false });

	async function load() {
		const [extensions, online] = await Promise.all([
			api.GET('/api/v1/core/extensions'),
			api.GET('/api/v1/core/extensions/found'),
		]);
		list = extensions.data ?? null;
		found = online.data ?? null;
		// The download this panel waits for is checked and staged: it installs like a file.
		const download = found?.download;
		if (
			foundOpen &&
			download?.status === 'ready' &&
			download.staged &&
			download.id === foundOpen.id &&
			download.version === foundOpen.version
		) {
			staged = download.staged;
			foundOpen = null;
		}
	}

	const looking = $derived(found?.search?.status === 'looking');
	/** The open found package's download, when it is the last one asked for. */
	const openDownload = $derived(
		foundOpen &&
			found?.download?.id === foundOpen.id &&
			found.download.version === foundOpen.version
			? found.download
			: null,
	);
	const downloading = $derived(openDownload?.status === 'downloading');
	const downloadFailure = $derived.by(() => {
		if (openDownload?.status !== 'failed' || !openDownload.problem) return null;
		const said = downloadProblem(openDownload.problem);
		return {
			text: t(said.headline.key, said.headline.values),
			...(said.detail && { detail: t(said.detail.key, said.detail.values) }),
		};
	});
	// The server says when a look or a download is done; this also notices if that word is lost.
	$effect(() => {
		if (!looking && !downloading) return;
		const timer = setInterval(() => void load(), 3000);
		return () => clearInterval(timer);
	});

	/** The server's start id when the page opened, so a restart asked elsewhere is noticed. */
	let bootAtOpen: string | null = null;
	$effect(() => {
		void readBoot().then((boot) => (bootAtOpen = boot));
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

	/**
	 * Turns an extension on or off for the whole family at once. The notice names it and offers
	 * Undo, since one tap changes it for everyone; undoing says what it is now, without another Undo.
	 */
	async function toggle(entry: Entry, enabled: boolean, undoable = true) {
		error = null;
		try {
			unwrap(
				await api.POST('/api/v1/actions/core.setFeatureEnabled', {
					body: { extensionId: entry.id, enabled },
				}),
			);
			const said = t(enabled ? 'extensions_turned_on' : 'extensions_turned_off', {
				name: name(entry),
			});
			toasts.show(
				said,
				undoable
					? { label: t('extensions_switch_undo'), run: () => void toggle(entry, !enabled, false) }
					: undefined,
			);
			await Promise.all([load(), session.refresh()]);
		} catch {
			error = t('error_generic');
			await load();
		}
	}

	async function install(
		entry: Entry,
		toast = t('extensions_installed_toast', { name: name(entry) }),
		undoable = false,
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
			toasts.show(
				toast,
				undoable
					? { label: t('extensions_switch_undo'), run: () => void uninstall(entry, false) }
					: undefined,
			);
		} catch (failure) {
			if (opened) panelError = explain(failure);
			else error = explain(failure);
		} finally {
			busy = false;
			await load();
		}
	}

	/** Sends the chosen file to be checked; nothing is installed until Install in the panel. */
	async function upload(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		error = null;
		fileError = null;
		panelError = null;
		busy = true;
		try {
			staged = unwrap(
				await api.POST('/api/v1/core/extensions/packages', {
					body: {},
					bodySerializer: () => {
						const form = new FormData();
						form.append('files', file, file.name);
						return form;
					},
				}),
			);
		} catch (failure) {
			const problem: FileProblem = isApiError(failure)
				? fileProblem(failure)
				: { headline: { key: 'error_generic' } };
			fileError = {
				text: t(problem.headline.key, problem.headline.values),
				...(problem.detail && { detail: t(problem.detail.key, problem.detail.values) }),
			};
		} finally {
			busy = false;
		}
	}

	async function installStaged(pkg: Staged) {
		busy = true;
		panelError = null;
		const shown = name(stagedEntry(pkg));
		try {
			unwrap(
				await api.POST('/api/v1/actions/core.installExtension', {
					body: { staged: pkg.digest },
				}),
			);
			staged = null;
			toasts.show(
				updateOf(pkg)
					? t('extensions_updated_toast', { name: shown })
					: t('extensions_installed_toast', { name: shown }),
			);
		} catch (failure) {
			panelError =
				isApiError(failure) && failure.status === 404
					? t('extensions_file_gone')
					: explain(failure);
		} finally {
			busy = false;
			await load();
		}
	}

	/** What the index gives takes focus once someone asks here, so it is announced where it is. */
	let foundBox = $state<HTMLElement | null>(null);

	/** Asks the server to read the official index; what it finds shows with what can be installed. */
	async function look() {
		error = null;
		try {
			unwrap(await api.POST('/api/v1/actions/core.findExtensions', { body: {} }));
		} catch {
			error = t('error_generic');
		} finally {
			await load();
			await tick();
			foundBox?.focus();
		}
	}

	async function downloadFound(pkg: FoundPackage) {
		foundError = null;
		try {
			unwrap(
				await api.POST('/api/v1/actions/core.downloadExtension', {
					body: { extensionId: pkg.id, version: pkg.version },
				}),
			);
		} catch (failure) {
			foundError =
				isApiError(failure) && failure.status === 404
					? t('extensions_download_gone')
					: t('error_generic');
		} finally {
			await load();
		}
	}

	const pageMenu = $derived<MenuItem[]>([
		{
			id: 'look',
			label: t('extensions_look'),
			icon: lookIcon,
			disabled: looking,
			onselect: () => void look(),
		},
		{
			id: 'file',
			label: t('extensions_add_file'),
			icon: fileIcon,
			onselect: () => fileInput?.click(),
		},
	]);

	/** Asks for the uninstall; Undo in the notice (and Keep on the row) takes it back. */
	async function uninstall(entry: Entry, undoable = true) {
		uninstalling = null;
		error = null;
		try {
			unwrap(
				await api.POST('/api/v1/actions/core.uninstallExtension', {
					body: { extensionId: entry.id },
				}),
			);
			toasts.show(
				t(undoable ? 'extensions_uninstalled_toast' : 'extensions_install_cancelled_toast', {
					name: name(entry),
				}),
				undoable
					? {
							label: t('extensions_switch_undo'),
							run: () => void install(entry, t('extensions_kept_toast', { name: name(entry) })),
						}
					: undefined,
			);
		} catch (failure) {
			error = explain(failure);
		} finally {
			await load();
		}
	}

	async function restart() {
		confirmingRestart = false;
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

	/** Who asked for a change that waits for a restart, and when, in words; null when unknown. */
	function askedLine(entry: Entry): string | null {
		const said = askedOf(
			entry,
			(memberId) => family.members.find((m) => m.id === memberId)?.displayName ?? null,
			(at) =>
				dateTimeFormat({
					dateStyle: 'medium',
					timeStyle: 'short',
					timeZone: family.timeZone,
				}).format(at),
			t('extensions_someone'),
		);
		return said ? t(said.key, said.values) : null;
	}

	/** The row's second line: its state while it waits or is left out, else what it is for. */
	function meta(entry: Entry): string {
		const asked = askedLine(entry);
		if (asked) return asked;
		if (entry.nextVersion) return t('extensions_status_updates', { version: entry.nextVersion });
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
				// The version is in Details; the row keeps to one line of what it is for.
				return description(entry);
		}
	}

	const blockers = $derived(uninstalling ? neededBy(uninstalling, entries) : []);
</script>

{#snippet infoIcon()}<Info class="size-4" aria-hidden="true" />{/snippet}
{#snippet retryIcon()}<RotateCcw class="size-4" aria-hidden="true" />{/snippet}
{#snippet keepIcon()}<Undo2 class="size-4" aria-hidden="true" />{/snippet}
{#snippet uninstallIcon()}<Trash2 class="size-4" aria-hidden="true" />{/snippet}
{#snippet fileIcon()}<FileUp class="size-4" aria-hidden="true" />{/snippet}
{#snippet lookIcon()}<Search class="size-4" aria-hidden="true" />{/snippet}

{#snippet foundSection()}
	<!-- What the index gave is announced when it arrives; focus lands here after a look. -->
	{#if found?.search}
		{@const search = found.search}
		<div
			bind:this={foundBox}
			tabindex="-1"
			aria-live="polite"
			class="outline-none"
			data-testid="found-online"
		>
			<Section
				label={t('extensions_found')}
				count={search.status === 'done' ? found.found.length : undefined}
			>
				{#if search.status === 'looking'}
					<EmptyLine text={t('extensions_looking')}>
						{#snippet icon()}<Search aria-hidden="true" />{/snippet}
					</EmptyLine>
				{:else if search.status === 'failed' && search.problem}
					{@const said = searchProblem(search.problem)}
					<Notice tone="alert">{t(said.key)}</Notice>
				{:else if found.found.length > 0}
					<Card rows data-testid="found-extensions">
						{#each shown.found as { pkg, update } (pkg.id)}
							{@const entry = foundEntry(pkg)}
							<Row
								title={name(entry)}
								meta={update
									? t('extensions_found_newer', { version: pkg.version })
									: description(entry)}
								onclick={() => {
									foundError = null;
									foundOpen = pkg;
								}}
								aria-label={name(entry)}
							>
								{#snippet trail()}
									<ChevronRight class="text-ink-soft size-4" aria-hidden="true" />
								{/snippet}
							</Row>
						{/each}
					</Card>
				{:else}
					<EmptyLine text={t('extensions_found_none')}>
						{#snippet icon()}<CircleCheck aria-hidden="true" />{/snippet}
					</EmptyLine>
				{/if}
			</Section>
		</div>
	{/if}
{/snippet}

{#snippet availableSection()}
	<Section label={t('extensions_available')} count={shown.available.length}>
		{#if shown.available.length > 0}
			<Card rows data-testid="available-extensions">
				{#each shown.available as entry (entry.id)}
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
{/snippet}

<Page template="settings">
	<PageHeader title={t('extensions_title')} subtitle={t('extensions_intro')}>
		{#snippet actions()}
			{#if list?.restartNeeded}
				<Button
					variant="primary"
					onclick={() => (confirmingRestart = true)}
					data-testid="restart-now"
					><RotateCcw aria-hidden="true" />{t('extensions_restart')}</Button
				>
			{/if}
			<RowMenu name={t('extensions_title')} items={pageMenu} />
			<input
				bind:this={fileInput}
				type="file"
				accept=".famext"
				class="hidden"
				onchange={upload}
				data-testid="extension-file"
			/>
		{/snippet}
	</PageHeader>

	{#if list}
		<div class="grid gap-7">
			{#if list.restartNeeded}
				<Notice>{t('extensions_restart_needed')}</Notice>
			{/if}
			{#if error}<Notice tone="alert">{error}</Notice>{/if}
			{#if fileError}
				<Notice tone="alert">
					{fileError.text}
					{#if fileError.detail}
						<span class="text-ink-soft mt-1 block text-[13px] break-words">{fileError.detail}</span>
					{/if}
				</Notice>
			{/if}
			<!-- What can be installed comes first: the installed list is long, and an extension that
			     was uninstalled is found again here, not below it. -->
			{#if shown.available.length > 0}{@render availableSection()}{/if}
			{@render foundSection()}

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
								onopen={() => openPanel(entry)}
								oneLine
							>
								{#snippet end()}<RowMenu name={name(entry)} items={menu(entry)} />{/snippet}
							</SwitchRow>
						{:else}
							<Row wrap title={name(entry)} meta={meta(entry)} data-testid="extension-{entry.id}">
								<!-- The second line says its state (waiting, or left out and why); said once. -->
								{#snippet trail()}
									{@const waiting = pendingOf(entry)}
									<!-- A change that waits for a restart can be taken back right here. -->
									{#if waiting === 'uninstall'}
										<Button
											variant="ghost"
											size="sm"
											data-testid="keep-{entry.id}"
											onclick={() =>
												void install(entry, t('extensions_kept_toast', { name: name(entry) }))}
											>{t('extensions_keep')}</Button
										>
									{:else if waiting === 'install'}
										<Button
											variant="ghost"
											size="sm"
											data-testid="cancel-install-{entry.id}"
											onclick={() => void uninstall(entry, false)}
											>{t('extensions_cancel_install')}</Button
										>
									{/if}
									<RowMenu name={name(entry)} items={menu(entry)} />
								{/snippet}
							</Row>
						{/if}
					{/each}
				</Card>
			</Section>

			{#if shown.available.length === 0}{@render availableSection()}{/if}

			<p class="text-ink-soft max-w-prose px-1 text-[13px]">{t('extensions_data_kept')}</p>
		</div>
	{/if}

	<ExtensionPanel
		entry={panelEntry}
		list={entries}
		{name}
		{description}
		{busy}
		{staged}
		error={panelError}
		oninstall={(entry) =>
			staged ? void installStaged(staged) : void install(entry, undefined, true)}
		onclose={() => {
			if (staged) {
				staged = null;
				panelError = null;
			} else closePanel();
		}}
	/>

	<FoundPanel
		pkg={staged ? null : foundOpen}
		update={shown.found.some(({ pkg, update }) => update && pkg.id === foundOpen?.id)}
		name={foundOpen ? name(foundEntry(foundOpen)) : ''}
		description={foundOpen ? description(foundEntry(foundOpen)) : ''}
		{downloading}
		problem={downloadFailure ?? (foundError ? { text: foundError } : null)}
		ondownload={(pkg) => void downloadFound(pkg)}
		onclose={() => (foundOpen = null)}
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

<Dialog
	open={confirmingRestart}
	title={t('extensions_restart_title')}
	description={t('extensions_restart_hint')}
	onclose={() => (confirmingRestart = false)}
>
	<ul class="grid gap-2 text-[14px]" data-testid="restart-changes">
		{#each entries.filter((e) => pendingOf(e)) as entry (entry.id)}
			<li>
				<span class="font-medium">{name(entry)}</span>
				<span class="text-ink-soft block text-[13px]">{askedLine(entry) ?? meta(entry)}</span>
			</li>
		{/each}
	</ul>
	{#snippet actions()}
		<Button variant="ghost" data-autofocus onclick={() => (confirmingRestart = false)}
			>{t('cancel')}</Button
		>
		<Button variant="primary" onclick={restart} data-testid="restart-confirm"
			>{t('extensions_restart')}</Button
		>
	{/snippet}
</Dialog>

{#if restarting}<Restarting before={restarting.before} />{/if}
