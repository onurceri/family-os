<script lang="ts">
	import { Pill } from '@famos/ui/famos';
	import { STYLES } from '@famos/ui/styles';
	import { Check } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import type { Theme } from '#lib/appearance.svelte.js';
	import { t } from '#lib/i18n.svelte.js';
	import ThemeCard from '#lib/ThemeCard.svelte';

	/**
	 * A theme as a card: its picture, its name, what it is for
	 * (`In use`, `Family default`), the style the pack suggests and the actions the page
	 * gives it. The one in use has an ink ring.
	 */
	let {
		theme,
		inUse = false,
		trying = false,
		familyDefault = false,
		actions,
	}: {
		theme: Theme;
		inUse?: boolean;
		trying?: boolean;
		familyDefault?: boolean;
		actions?: Snippet;
	} = $props();
</script>

<li
	class="bg-surface grid content-start gap-3 rounded-[var(--r-card)] p-3 {inUse
		? 'shadow-[inset_0_0_0_2px_var(--ink)]'
		: trying
			? 'shadow-[inset_0_0_0_2px_var(--info)]'
			: 'shadow-[inset_0_0_0_1px_var(--line)]'}"
	data-testid="theme-{theme.id}"
	aria-current={inUse ? 'true' : undefined}
>
	<ThemeCard {theme} />
	<div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-0.5">
		<span class="text-[0.9375rem] font-bold">{theme.name}</span>
		<span class="text-ink-soft ms-auto text-xs font-semibold"
			>{t(`appearance_source_${theme.source}` as 'appearance_source_bundled')}</span
		>
	</div>
	{#if familyDefault || inUse}
		<div class="flex flex-wrap items-center gap-1.5 px-0.5">
			{#if familyDefault}<Pill>{t('appearance_family_badge')}</Pill>{/if}
			{#if inUse}
				<span data-testid="theme-in-use">
					<Pill tone="now">
						{#snippet icon()}<Check aria-hidden="true" />{/snippet}
						{t('appearance_in_use')}
					</Pill>
				</span>
			{/if}
		</div>
	{/if}
	{#if theme.style}
		<p class="text-ink-soft px-0.5 text-xs" data-testid="theme-suggests-style">
			{t('appearance_suggests_style', { name: t(STYLES[theme.style].nameKey) })}
		</p>
	{/if}
	{#if theme.overridesBundled}
		<p class="text-ink-soft px-0.5 text-xs">{t('appearance_overrides')}</p>
	{/if}
	{#if actions}<div class="flex flex-wrap items-center gap-2">{@render actions()}</div>{/if}
</li>
