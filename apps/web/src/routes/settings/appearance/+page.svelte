<script lang="ts">
	import { goto } from '$app/navigation';

	import { Button } from '@famos/ui/button';
	import { Card, Page, PageHeader, Pill, Section, Segmented, SettingRow } from '@famos/ui/famos';
	import { DEFAULT_STYLE, STYLE_IDS, STYLES, type StyleId } from '@famos/ui/styles';
	import { Check, Eye } from '@lucide/svelte';
	import { api } from '#lib/api.js';
	import { type Answer, runAction } from '#lib/run-action.js';
	import { appearance } from '#lib/appearance.svelte.js';
	import { family } from '#lib/family.svelte.js';
	import { t } from '#lib/i18n.svelte.js';
	import PaletteSample from '#lib/PaletteSample.svelte';
	import { onEvent } from '#lib/realtime.js';
	import { session } from '#lib/session.svelte.js';
	import ThemeTile from '#lib/ThemeTile.svelte';
	import StylePreview from '#lib/today/StylePreview.svelte';
	import TodayBlocksList from '#lib/today/TodayBlocksList.svelte';
	import { availableTodayBlocks } from '#lib/today/today-data.svelte.js';
	import { dayNight, type Mode } from '#lib/theme.svelte.js';

	/**
	 * Appearance: only what is yours. First the
	 * style, as three live pictures of Today; then the colors (day or night on this device, a live
	 * sample of the palette on screen and your own theme). Trying a style opens Today, where it
	 * shows; trying a theme recolours this page. Either lasts across the app, with the shell's
	 * preview bar, until it is used or stopped. The family's defaults are under Family, Theme.
	 */
	const manage = $derived(session.can('core.settings.manage'));
	let error = $state<string | null>(null);

	const MODES: Mode[] = ['system', 'day', 'night'];
	const modeOptions = $derived(
		MODES.map((mode) => ({ value: mode, label: t(`appearance_mode_${mode}`) })),
	);

	const styleName = (id: StyleId) => t(STYLES[id].nameKey);
	/** The palette on screen: the one tried, else the one in use. */
	const shownTheme = $derived(
		appearance.themes.find(
			(th) => th.id === (appearance.previewing ?? appearance.current ?? appearance.family),
		)?.name ?? '',
	);

	/** A style shows on Today: trying one goes there (Back returns here). */
	function tryStyle(id: StyleId) {
		appearance.previewStyle(id);
		void goto('/');
	}

	const familyName = $derived(
		appearance.themes.find((th) => th.id === appearance.family)?.name ?? appearance.family ?? '',
	);
	/** The style the family's choice comes to: its own, else its theme's suggestion. */
	const familyStyle = $derived<StyleId>(
		appearance.familyStyle ??
			appearance.themes.find((th) => th.id === appearance.family)?.style ??
			DEFAULT_STYLE,
	);

	$effect(() => {
		void appearance.loadThemes();
		return onEvent('core.themes.', () => void appearance.loadThemes());
	});

	function save<T>(request: Promise<Answer<T>>) {
		error = null;
		return runAction(request, {
			saved: t('appearance_saved'),
			onError: (failure) => (error = failure.message),
			reload: () => Promise.all([appearance.loadThemes(), appearance.refresh()]),
		});
	}

	/** What Today shows for this person: the blocks they may see, theirs or the family's choice. */
	const blocks = $derived(
		availableTodayBlocks({
			can: (capability) => session.can(capability),
			disabledExtensions: session.disabledExtensions,
		}),
	);
	async function chooseBlocks(hidden: string[] | null) {
		error = null;
		try {
			await appearance.setMyHidden(hidden);
		} catch {
			error = t('error_generic');
		}
	}

	const chooseMine = (theme: string | null) =>
		save(api.POST('/api/v1/actions/core.setMyTheme', { body: { theme } }));
	const chooseMyStyle = (style: StyleId | null) =>
		save(api.POST('/api/v1/actions/core.setMyStyle', { body: { style } }));
</script>

<Page template="settings">
	<PageHeader title={t('appearance_title')} />

	<div class="grid gap-7">
		<Section label={t('appearance_styles')} count={t('appearance_yours_everywhere')}>
			{#snippet actions()}
				{#if appearance.myStyle}
					<Button
						type="button"
						variant="ghost"
						size="sm"
						data-testid="style-follow-family"
						onclick={() => chooseMyStyle(null)}
						>{t('appearance_follow_family', { name: styleName(familyStyle) })}</Button
					>
				{/if}
			{/snippet}
			<p class="text-ink-soft max-w-prose px-1 text-[13px]">{t('appearance_styles_hint')}</p>
			<ul class="grid gap-3 @3xl:grid-cols-3">
				{#each STYLE_IDS as id (id)}
					{@const inUse = appearance.style === id}
					{@const tryingThis = appearance.previewingStyle === id}
					{@const following = !appearance.myStyle && familyStyle === id}
					<li
						class="bg-surface grid content-start gap-3 rounded-[var(--r-card)] p-3 {inUse
							? 'shadow-[inset_0_0_0_2px_var(--ink)]'
							: tryingThis
								? 'shadow-[inset_0_0_0_2px_var(--info)]'
								: 'shadow-[inset_0_0_0_1px_var(--line)]'}"
						data-testid="style-{id}"
						aria-current={inUse ? 'true' : undefined}
					>
						<div class="overflow-hidden rounded-[var(--r-item)] border">
							{#key family.timeZone}<StylePreview style={id} />{/key}
						</div>
						<div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-0.5">
							<span class="text-[15px] font-bold">{styleName(id)}</span>
							{#if inUse}
								<span class="ms-auto" data-testid="style-in-use">
									<Pill tone="now">
										{#snippet icon()}<Check aria-hidden="true" />{/snippet}
										{t('appearance_in_use')}
									</Pill>
								</span>
							{:else if familyStyle === id}
								<span class="ms-auto"><Pill>{t('appearance_family_badge')}</Pill></span>
							{/if}
						</div>
						<div class="flex flex-wrap items-center gap-2">
							{#if following}
								<span
									class="text-ink-soft grid min-h-10 flex-1 place-items-center text-sm font-semibold"
									>{t('appearance_following')}</span
								>
							{:else if appearance.myStyle !== id}
								<Button
									type="button"
									variant="secondary"
									class="flex-1"
									data-testid="use-style-{id}"
									onclick={() => chooseMyStyle(id)}>{t('appearance_use')}</Button
								>
							{/if}
							{#if !inUse && !tryingThis}
								<Button
									type="button"
									size="sm"
									variant="ghost"
									data-testid="try-style-{id}"
									aria-label={t('appearance_try_named', { name: styleName(id) })}
									onclick={() => tryStyle(id)}
									><Eye class="size-4" aria-hidden="true" />{t('appearance_preview')}</Button
								>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		</Section>

		<div id="today-blocks" class="scroll-mt-6">
			<Section label={t('blocks_title')} count={t('appearance_yours_everywhere')}>
				<p class="text-ink-soft max-w-prose px-1 text-[13px]">{t('blocks_hint')}</p>
				<TodayBlocksList
					id="my-blocks"
					{blocks}
					hidden={appearance.hidden}
					onchange={chooseBlocks}
					follow={{
						own: appearance.myHidden !== null,
						followLabel: t('blocks_follow'),
						ownLabel: t('blocks_own'),
					}}
				/>
			</Section>
		</div>

		<Section label={t('appearance_themes')} count={t('appearance_yours_everywhere')}>
			{#snippet actions()}
				{#if appearance.mine}
					<Button type="button" variant="ghost" size="sm" onclick={() => chooseMine(null)}
						>{t('appearance_follow_family', { name: familyName })}</Button
					>
				{/if}
			{/snippet}
			<Card>
				<SettingRow label={t('appearance_mode')} hint={t('appearance_mode_hint')}>
					{#snippet control()}
						<Segmented
							grow
							label={t('appearance_mode')}
							options={modeOptions}
							value={dayNight.mode}
							onchange={(mode) => dayNight.set(mode as Mode)}
						/>
					{/snippet}
				</SettingRow>
			</Card>
			<PaletteSample name={shownTheme} />
			<ul class="grid gap-3 @sm:grid-cols-2 @2xl:grid-cols-3">
				{#each appearance.themes as theme (theme.id)}
					{@const inUse = appearance.current === theme.id}
					{@const tryingThis = appearance.previewing === theme.id}
					{@const following = !appearance.mine && appearance.family === theme.id}
					<ThemeTile
						{theme}
						{inUse}
						trying={tryingThis}
						familyDefault={appearance.family === theme.id}
					>
						{#snippet actions()}
							{#if following}
								<span
									class="text-ink-soft grid min-h-10 flex-1 place-items-center text-sm font-semibold"
									>{t('appearance_following')}</span
								>
							{:else if appearance.mine !== theme.id}
								<Button
									type="button"
									variant="secondary"
									class="flex-1"
									data-testid="use-{theme.id}"
									onclick={() => chooseMine(theme.id)}>{t('appearance_use')}</Button
								>
							{/if}
							{#if !inUse && !tryingThis}
								<Button
									type="button"
									size="sm"
									variant="ghost"
									data-testid="preview-{theme.id}"
									onclick={() => appearance.preview(theme.id)}
									><Eye class="size-4" aria-hidden="true" />{t('appearance_preview')}</Button
								>
							{/if}
						{/snippet}
					</ThemeTile>
				{/each}
			</ul>
		</Section>

		{#if manage}
			<p class="text-ink-soft px-1 text-[13px]">
				{t('appearance_family_elsewhere')}
				<a class="text-info font-semibold underline underline-offset-2" href="/settings/theme"
					>{t('appearance_family_elsewhere_link')}</a
				>
			</p>
		{/if}

		{#if error}<p class="text-attention font-semibold" role="alert">{error}</p>{/if}
	</div>
</Page>
