<script lang="ts">
	import { Button } from '@famos/ui/button';
	import {
		Card,
		ConfirmButton,
		Page,
		PageHeader,
		Section,
		Segmented,
		SettingRow,
		SidePanel,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { DEFAULT_STYLE, STYLE_IDS, STYLES, type StyleId } from '@famos/ui/styles';
	import { Plus } from '@lucide/svelte';
	import { onDestroy } from 'svelte';
	import { api } from '#lib/api.js';
	import { appearance, type Theme } from '#lib/appearance.svelte.js';
	import { t } from '#lib/i18n.svelte.js';
	import { type Answer, runAction } from '#lib/run-action.js';
	import { onEvent } from '#lib/realtime.js';
	import SelectField from '#lib/SelectField.svelte';
	import { session } from '#lib/session.svelte.js';
	import { toasts } from '#lib/toast.svelte.js';
	import ThemeTile from '#lib/ThemeTile.svelte';
	import TodayBlocksList from '#lib/today/TodayBlocksList.svelte';
	import { availableTodayBlocks } from '#lib/today/today-data.svelte.js';

	/**
	 * Theme: the family's default style and
	 * theme, the style and theme each display uses, and adding a theme pack from a file or an
	 * address.
	 */
	type Fetch = { status: 'fetching' | 'done' | 'failed'; url: string; error: string | null } | null;
	type Display = { id: string; name: string };

	let adding = $state(false);
	let url = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let addError = $state<string | null>(null);
	let fetchState = $state<Fetch>(null);
	let displays = $state<Display[]>([]);
	/** The theme chosen per display (display id → theme id). */
	let displayThemes = $state<Record<string, string>>({});
	/** The style chosen per display (display id → style id). */
	let displayStyles = $state<Record<string, StyleId>>({});
	/** What each display's Today hides (display id → block ids); missing follows the family. */
	let displayHidden = $state<Record<string, string[]>>({});
	/** The display whose "What it shows" panel is open. */
	let blocksFor = $state<Display | null>(null);

	/** What the family's Today can show: every card that is on (people differ in what they see). */
	const familyBlocks = $derived(
		availableTodayBlocks({ disabledExtensions: session.disabledExtensions }),
	);
	/** What a display's Today can show: the cards with a glance, nothing only a person has. */
	const displayBlocks = $derived(
		availableTodayBlocks({ familyMode: true, disabledExtensions: session.disabledExtensions }),
	);
	const displaySummary = (id: string) => {
		const own = displayHidden[id];
		if (!own) return t('blocks_display_follows');
		const count = displayBlocks.filter((b) => own.includes(b.id)).length;
		return count === 0 ? t('blocks_display_all') : t('blocks_display_hidden', { count });
	};

	const styleName = (id: StyleId) => t(STYLES[id].nameKey);
	const styleOptions = $derived(STYLE_IDS.map((id) => ({ value: id, label: styleName(id) })));
	const familyTheme = $derived(appearance.themes.find((th) => th.id === appearance.family));
	/** The family's style: its own choice, else its theme's suggestion, else the default. */
	const familyStyle = $derived<StyleId>(
		appearance.familyStyle ?? familyTheme?.style ?? DEFAULT_STYLE,
	);

	/** A theme tried here, for the family's default; a person's own try has the app's bar. */
	const previewed = $derived(
		appearance.previewingForFamily
			? appearance.themes.find((th) => th.id === appearance.previewing)
			: undefined,
	);
	// Trying the family's theme never outlives the page.
	onDestroy(() => {
		if (appearance.previewingForFamily) appearance.endPreview();
	});

	async function refresh() {
		await appearance.loadThemes();
		const devicesManage = session.can('core.devices.manage');
		const [fetched, chosen, styles, devices, blocks] = await Promise.all([
			api.GET('/api/v1/core/themes/fetch'),
			api.GET('/api/v1/core/themes/displays'),
			devicesManage ? api.GET('/api/v1/core/styles/displays') : null,
			devicesManage ? api.GET('/api/v1/core/devices') : null,
			devicesManage ? api.GET('/api/v1/core/today/displays') : null,
		]);
		displayHidden = blocks?.data ?? {};
		fetchState = fetched.data ?? null;
		displayThemes = chosen.data ?? {};
		displayStyles = styles?.data ?? {};
		displays = (devices?.data ?? []).filter((d) => d.kind === 'kiosk');
	}
	$effect(() => {
		if (!session.can('core.settings.manage')) return;
		void refresh();
		const off = onEvent('core.themes.', () => void refresh());
		const offDevices = onEvent('core.device.', () => void refresh());
		return () => {
			off();
			offDevices();
		};
	});

	function run<T>(request: Promise<Answer<T>>, saved?: string) {
		error = null;
		return runAction(request, {
			...(saved && { saved }),
			onError: (failure) => (error = failure.message),
			reload: () => Promise.all([refresh(), appearance.refresh()]),
		});
	}

	const chooseFamily = (theme: string) =>
		run(
			api.POST('/api/v1/actions/core.setFamilyTheme', { body: { theme } }),
			t('appearance_saved'),
		);

	const chooseDisplay = (deviceId: string, theme: string) =>
		run(
			api.POST('/api/v1/actions/core.setDisplayTheme', {
				body: { deviceId, theme: theme === '' ? null : theme },
			}),
			t('appearance_saved'),
		);

	const chooseFamilyStyle = (style: StyleId) =>
		run(
			api.POST('/api/v1/actions/core.setFamilyStyle', { body: { style } }),
			t('appearance_saved'),
		);

	const chooseDisplayStyle = (deviceId: string, style: string) =>
		run(
			api.POST('/api/v1/actions/core.setDisplayStyle', {
				body: { deviceId, style: style === '' ? null : (style as StyleId) },
			}),
			t('appearance_saved'),
		);

	const chooseFamilyBlocks = (hidden: string[] | null) =>
		run(api.POST('/api/v1/actions/core.setFamilyTodayBlocks', { body: { hidden: hidden ?? [] } }));

	const chooseDisplayBlocks = (deviceId: string, hidden: string[] | null) =>
		run(api.POST('/api/v1/actions/core.setDisplayTodayBlocks', { body: { deviceId, hidden } }));

	async function install(pack: {
		manifest: Record<string, unknown>;
		tokens: Record<string, unknown>;
		fonts?: Record<string, string>;
	}) {
		busy = true;
		addError = null;
		try {
			const res = await api.POST('/api/v1/actions/core.installThemePack', { body: { pack } });
			if (res.data?.status === 'applied') {
				const { theme, warnings } = res.data.output;
				toasts.show(t('appearance_installed_ok', { name: theme.name }));
				if (warnings.length > 0) toasts.show(t('appearance_notes', { count: warnings.length }));
				adding = false;
			} else {
				const message = (res.error as { error?: { message?: string } } | undefined)?.error?.message;
				addError = t('appearance_install_failed', { reason: message ?? t('error_generic') });
			}
			await refresh();
		} catch {
			addError = t('error_generic');
		} finally {
			busy = false;
		}
	}

	async function installFile(event: Event & { currentTarget: HTMLInputElement }) {
		const input = event.currentTarget;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		addError = null;
		try {
			const pack = JSON.parse(await file.text()) as {
				manifest?: Record<string, unknown>;
				tokens?: Record<string, unknown>;
				fonts?: Record<string, string>;
			};
			if (typeof pack !== 'object' || !pack.manifest || !pack.tokens) throw new Error('shape');
			await install({
				manifest: pack.manifest,
				tokens: pack.tokens,
				...(pack.fonts && { fonts: pack.fonts }),
			});
		} catch {
			addError = t('appearance_bad_file');
		}
	}

	async function installUrl(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		addError = null;
		const result = await runAction(
			api.POST('/api/v1/actions/core.installThemePackFromUrl', { body: { url } }),
			{ onError: (failure) => (addError = failure.message), reload: refresh },
		);
		if (result.ok) {
			url = '';
			adding = false;
		}
		busy = false;
	}

	async function remove(theme: Theme) {
		await run(
			api.POST('/api/v1/actions/core.removeThemePack', { body: { id: theme.id } }),
			t('appearance_removed', { name: theme.name }),
		);
	}
</script>

<Page template="settings">
	<PageHeader title={t('nav_theme')} subtitle={t('theme_intro')} />

	<div class="grid gap-7">
		<Section label={t('theme_style_title')} count={t('theme_family_hint')}>
			<Card>
				<SettingRow
					label={t('theme_style_label')}
					hint={appearance.familyStyle === null && familyTheme?.style
						? t('theme_style_suggested', {
								theme: familyTheme.name,
								style: styleName(familyTheme.style),
							})
						: t('theme_style_hint')}
				>
					{#snippet control()}
						<Segmented
							grow
							label={t('theme_style_label')}
							options={styleOptions}
							value={familyStyle}
							onchange={(style) => chooseFamilyStyle(style as StyleId)}
						/>
					{/snippet}
				</SettingRow>
			</Card>
		</Section>

		<Section label={t('blocks_title')} count={t('theme_family_hint')}>
			<p class="text-ink-soft max-w-prose px-1 text-[13px]">{t('blocks_family_hint')}</p>
			<TodayBlocksList
				id="family-blocks"
				blocks={familyBlocks}
				hidden={appearance.familyHidden}
				onchange={chooseFamilyBlocks}
			/>
		</Section>

		<Section label={t('theme_family_title')} count={t('theme_family_hint')}>
			{#snippet actions()}
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onclick={() => ((adding = true), (addError = null))}
					><Plus class="size-4" aria-hidden="true" />{t('appearance_install_title')}</Button
				>
			{/snippet}
			<ul class="grid gap-3 @sm:grid-cols-2 @2xl:grid-cols-3">
				{#each appearance.themes as theme (theme.id)}
					{@const isFamily = appearance.family === theme.id}
					{@const trying = appearance.previewing === theme.id}
					<ThemeTile {theme} familyDefault={isFamily} inUse={isFamily} {trying}>
						{#snippet actions()}
							{#if !isFamily}
								<Button
									type="button"
									variant="secondary"
									class="flex-1"
									data-testid="family-{theme.id}"
									onclick={() => chooseFamily(theme.id)}>{t('appearance_make_family')}</Button
								>
							{/if}
							{#if !trying && appearance.current !== theme.id}
								<Button
									type="button"
									size="sm"
									variant="ghost"
									data-testid="preview-{theme.id}"
									onclick={() => appearance.preview(theme.id, { forFamily: true })}
									>{t('appearance_preview')}</Button
								>
							{/if}
							{#if theme.source === 'installed'}
								<ConfirmButton
									label={t('appearance_remove')}
									confirmLabel={t('appearance_remove_confirm', { name: theme.name })}
									onconfirm={() => remove(theme)}
								/>
							{/if}
						{/snippet}
					</ThemeTile>
				{/each}
			</ul>
		</Section>

		{#if displays.length > 0}
			<Section label={t('theme_displays_title')} count={displays.length}>
				<Card rows>
					{#each displays as display (display.id)}
						<SettingRow
							label={display.name}
							for="display-style-{display.id}"
							hint={t('devices_display_theme_hint')}
						>
							{#snippet control()}
								<div class="grid gap-2">
									<span aria-hidden="true" class="text-ink-soft -mb-1 text-xs font-semibold"
										>{t('theme_style_label')}</span
									>
									<SelectField
										id="display-style-{display.id}"
										aria-label={t('theme_display_style', { name: display.name })}
										value={displayStyles[display.id] ?? ''}
										onchange={(e) => chooseDisplayStyle(display.id, e.currentTarget.value)}
									>
										<option value=""
											>{t('theme_display_style_default', { name: styleName(familyStyle) })}</option
										>
										{#each STYLE_IDS as id (id)}
											<option value={id}>{styleName(id)}</option>
										{/each}
									</SelectField>
									<span aria-hidden="true" class="text-ink-soft -mb-1 text-xs font-semibold"
										>{t('devices_display_theme')}</span
									>
									<SelectField
										id="display-theme-{display.id}"
										aria-label={t('theme_display_theme', { name: display.name })}
										value={displayThemes[display.id] ?? ''}
										onchange={(e) => chooseDisplay(display.id, e.currentTarget.value)}
									>
										<option value=""
											>{t('theme_display_theme_default', { name: familyTheme?.name ?? '' })}</option
										>
										{#each appearance.themes as theme (theme.id)}
											<option value={theme.id}>{theme.name}</option>
										{/each}
									</SelectField>
									<span aria-hidden="true" class="text-ink-soft -mb-1 text-xs font-semibold"
										>{t('blocks_title')}</span
									>
									<Button
										type="button"
										variant="secondary"
										class="justify-between"
										data-testid="display-blocks-{display.id}"
										aria-label={t('blocks_display_title', { name: display.name })}
										onclick={() => (blocksFor = display)}>{displaySummary(display.id)}</Button
									>
								</div>
							{/snippet}
						</SettingRow>
					{/each}
				</Card>
			</Section>
		{/if}

		{#if error}<p class="text-attention font-semibold" role="alert">{error}</p>{/if}
		{#if previewed}
			<div
				class="bg-surface shadow-pop sticky bottom-24 z-30 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--r-card)] border px-4 py-3 md:bottom-6"
				role="status"
				data-testid="theme-preview-bar"
			>
				<div class="grid min-w-0 flex-1 gap-0.5">
					<span class="font-bold">{t('appearance_previewing', { name: previewed.name })}</span>
					<small class="text-ink-soft text-xs">{t('appearance_preview_hint')}</small>
				</div>
				<div class="flex flex-wrap gap-2">
					<Button type="button" size="sm" onclick={() => chooseFamily(previewed.id)}
						>{t('appearance_make_family')}</Button
					>
					<Button type="button" size="sm" variant="ghost" onclick={() => appearance.endPreview()}
						>{t('appearance_preview_end')}</Button
					>
				</div>
			</div>
		{/if}
	</div>

	<SidePanel
		open={blocksFor !== null}
		title={blocksFor ? t('blocks_display_title', { name: blocksFor.name }) : ''}
		closeLabel={t('side_panel_close')}
		onclose={() => (blocksFor = null)}
	>
		{#if blocksFor}
			{@const display = blocksFor}
			<div class="grid gap-3">
				<p class="text-ink-soft text-[13px]">{t('blocks_display_hint')}</p>
				<TodayBlocksList
					id="display-blocks"
					blocks={displayBlocks}
					hidden={displayHidden[display.id] ?? appearance.familyHidden}
					onchange={(hidden) => chooseDisplayBlocks(display.id, hidden)}
					follow={{
						own: displayHidden[display.id] !== undefined,
						followLabel: t('blocks_follow'),
						ownLabel: t('blocks_display_own'),
					}}
				/>
			</div>
		{/if}
	</SidePanel>

	<SidePanel
		open={adding}
		title={t('appearance_install_title')}
		closeLabel={t('side_panel_close')}
		onclose={() => (adding = false)}
	>
		<div class="grid gap-6">
			<div class="grid gap-2">
				<Label for="theme-file">{t('appearance_install_file')}</Label>
				<input
					id="theme-file"
					type="file"
					accept=".json,application/json"
					disabled={busy}
					onchange={installFile}
					class="file:bg-idle file:text-ink text-ink-soft text-sm file:mr-3 file:min-h-10 file:cursor-pointer file:rounded-[var(--r-ctl)] file:border-0 file:px-3 file:font-semibold"
				/>
				<p class="text-ink-soft text-[13px]">{t('appearance_install_file_hint')}</p>
			</div>
			<form class="grid gap-2" onsubmit={installUrl}>
				<Label for="theme-url">{t('appearance_install_url')}</Label>
				<Input
					id="theme-url"
					type="url"
					bind:value={url}
					placeholder="https://"
					autocomplete="off"
					spellcheck={false}
					required
				/>
				<p class="text-ink-soft text-[13px]">{t('appearance_install_url_hint')}</p>
				{#if fetchState?.status === 'fetching'}
					<p class="text-ink-soft text-sm" role="status">{t('appearance_fetching')}</p>
				{:else if fetchState?.status === 'failed'}
					<p class="text-attention text-sm font-semibold" role="alert">
						{t('appearance_fetch_failed', { reason: fetchState.error ?? t('error_generic') })}
					</p>
				{/if}
				<div>
					<Button type="submit" variant="primary" disabled={busy}
						>{t('appearance_install_button')}</Button
					>
				</div>
			</form>
			{#if addError}<p class="text-attention text-sm font-semibold" role="alert">{addError}</p>{/if}
		</div>
	</SidePanel>
</Page>
