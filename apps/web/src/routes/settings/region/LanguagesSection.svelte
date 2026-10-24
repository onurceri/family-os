<script lang="ts">
	import { Button } from '@famos/ui/button';
	import { Card, ConfirmButton, Pill, Row, Section, SidePanel } from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { Plus } from '@lucide/svelte';
	import { api } from '#lib/api.js';
	import { runAction } from '#lib/run-action.js';
	import { family } from '#lib/family.svelte.js';
	import { getLanguages, loadLanguages, t } from '#lib/i18n.svelte.js';
	import { onEvent } from '#lib/realtime.js';
	import { session } from '#lib/session.svelte.js';
	import { toasts } from '#lib/toast.svelte.js';

	/**
	 * The language packs: which languages are available, how much each translates, and
	 * adding or removing packs. The language only chooses words; dates, times and numbers follow
	 * the region. Adding a pack happens in a panel.
	 */
	type Fetch = { status: 'fetching' | 'done' | 'failed'; url: string; error: string | null } | null;

	let adding = $state(false);
	let url = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let fetchState = $state<Fetch>(null);

	async function loadFetchState() {
		const res = await api.GET('/api/v1/core/languages/fetch');
		fetchState = res.data ?? null;
	}
	/** After a change made here: the list and the fetch state again. */
	async function refresh() {
		await Promise.all([loadLanguages(), loadFetchState()]);
	}
	// The list of languages comes from the shell, which reads it at sign-in and again on every
	// `core.languages.` event; this page only adds the state of a pack being fetched.
	$effect(() => {
		void loadFetchState();
		return onEvent('core.languages.', () => void loadFetchState());
	});

	const percent = (coverage: number) => Math.floor(coverage * 100);
	const sourceLabel = (source: string) =>
		t(`languages_source_${source}` as 'languages_source_base');

	/** Reports what an install did: success with unusable strings, or the reason it was refused. */
	async function install(pack: {
		manifest: Record<string, unknown>;
		catalogs: Record<string, unknown>;
	}) {
		busy = true;
		error = null;
		try {
			const res = await api.POST('/api/v1/actions/core.installLanguagePack', { body: { pack } });
			if (res.data?.status === 'applied') {
				const { language, problems, moreProblems } = res.data.output;
				toasts.show(t('languages_installed_ok', { name: language.nativeName }));
				if (problems.length + moreProblems > 0)
					toasts.show(t('languages_problems', { count: problems.length + moreProblems }));
				adding = false;
			} else {
				const message = (res.error as { error?: { message?: string } } | undefined)?.error?.message;
				error = t('languages_install_failed', { reason: message ?? t('error_generic') });
			}
			await refresh();
		} catch {
			error = t('error_generic');
		} finally {
			busy = false;
		}
	}

	async function installFile(event: Event & { currentTarget: HTMLInputElement }) {
		const input = event.currentTarget;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		error = null;
		try {
			const pack = JSON.parse(await file.text()) as {
				manifest?: Record<string, unknown>;
				catalogs?: Record<string, unknown>;
			};
			if (typeof pack !== 'object' || !pack.manifest || !pack.catalogs) throw new Error('shape');
			await install({ manifest: pack.manifest, catalogs: pack.catalogs });
		} catch {
			error = t('languages_bad_file');
		}
	}

	async function installUrl(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = null;
		const result = await runAction(
			api.POST('/api/v1/actions/core.installLanguagePackFromUrl', { body: { url } }),
			{ onError: (failure) => (error = failure.message), reload: refresh },
		);
		if (result.ok) {
			url = '';
			adding = false;
		}
		busy = false;
	}

	async function remove(code: string, name: string) {
		error = null;
		await runAction(api.POST('/api/v1/actions/core.removeLanguagePack', { body: { code } }), {
			saved: t('languages_removed', { name }),
			onError: (failure) => (error = failure.message),
			reload: () => Promise.all([refresh(), family.refresh(), session.refresh()]),
		});
	}
</script>

<Section label={t('languages_available')} count={getLanguages().length}>
	{#snippet actions()}
		<Button variant="ghost" size="sm" onclick={() => ((adding = true), (error = null))}
			><Plus class="size-4" aria-hidden="true" />{t('languages_install_title')}</Button
		>
	{/snippet}
	<Card rows>
		{#each getLanguages() as language (language.code)}
			<Row
				title={language.nativeName}
				meta={[
					language.name !== language.nativeName ? language.name : null,
					language.source !== 'base'
						? t('languages_coverage', { percent: percent(language.coverage) })
						: null,
					language.overridesBundled ? t('languages_overrides') : null,
				]
					.filter(Boolean)
					.join(' · ') || undefined}
				lang={language.code}
				data-testid="language-{language.code}"
			>
				{#snippet trail()}
					<Pill>{sourceLabel(language.source)}</Pill>
					{#if language.source === 'installed'}
						<ConfirmButton
							label={t('languages_remove')}
							confirmLabel={t('languages_remove_confirm_short')}
							onconfirm={() => remove(language.code, language.nativeName)}
						/>
					{/if}
				{/snippet}
			</Row>
		{/each}
	</Card>
	{#if error && !adding}<p class="text-attention text-sm font-semibold" role="alert">
			{error}
		</p>{/if}
</Section>

<SidePanel
	open={adding}
	title={t('languages_install_title')}
	closeLabel={t('side_panel_close')}
	onclose={() => (adding = false)}
>
	<div class="grid gap-6">
		<div class="grid gap-2">
			<Label for="pack-file">{t('languages_install_file')}</Label>
			<input
				id="pack-file"
				type="file"
				accept=".json,application/json"
				disabled={busy}
				onchange={installFile}
				class="file:bg-idle file:text-ink text-ink-soft text-sm file:mr-3 file:min-h-10 file:cursor-pointer file:rounded-[var(--r-ctl)] file:border-0 file:px-3 file:font-semibold"
			/>
			<p class="text-ink-soft text-[13px]">{t('languages_install_file_hint')}</p>
		</div>
		<form class="grid gap-2" onsubmit={installUrl}>
			<Label for="pack-url">{t('languages_install_url')}</Label>
			<Input
				id="pack-url"
				type="url"
				bind:value={url}
				placeholder="https://"
				autocomplete="off"
				spellcheck={false}
				required
			/>
			<p class="text-ink-soft text-[13px]">{t('languages_install_url_hint')}</p>
			{#if fetchState?.status === 'fetching'}
				<p class="text-ink-soft text-sm" role="status">{t('languages_fetching')}</p>
			{:else if fetchState?.status === 'failed'}
				<p class="text-attention text-sm font-semibold" role="alert">
					{t('languages_fetch_failed', { reason: fetchState.error ?? t('error_generic') })}
				</p>
			{/if}
			<div>
				<Button type="submit" variant="primary" disabled={busy}
					>{t('languages_install_button')}</Button
				>
			</div>
		</form>
		{#if error}<p class="text-attention text-sm font-semibold" role="alert">{error}</p>{/if}
	</div>
</SidePanel>
