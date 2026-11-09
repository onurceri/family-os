<script lang="ts">
	import type { Theme, ThemeSwatches } from '#lib/appearance.svelte.js';
	import { t } from '#lib/i18n.svelte.js';

	/**
	 * A theme as a small picture of itself: the day palette with a card on it (ink and soft text,
	 * the state dots) and the night palette beside it. The colors are the theme's own, read from
	 * the server's validated values, which is why they are set inline here and nowhere else.
	 */
	let { theme }: { theme: Theme } = $props();

	const states = ['attention', 'now', 'sun', 'info'] as const;
</script>

{#snippet palette(colors: ThemeSwatches, label: string, wide: boolean)}
	<div
		class="grid content-center gap-1.5 rounded-lg border p-2.5 {wide ? 'flex-1' : 'w-20'}"
		style:background-color={colors.wall}
		style:border-color={colors['ink-soft']}
		role="img"
		aria-label={label}
	>
		<div
			class="grid gap-1 rounded-md p-2"
			style:background-color={colors.surface}
			style:color={colors.ink}
		>
			<span class="text-sm leading-none font-extrabold">Aa</span>
			<span class="text-[0.625rem] leading-none font-semibold" style:color={colors['ink-soft']}
				>Aa</span
			>
			<span class="flex gap-1 pt-0.5">
				{#each states as state (state)}
					<span class="size-2 rounded-full" style:background-color={colors[state]}></span>
				{/each}
			</span>
		</div>
	</div>
{/snippet}

<div class="flex gap-2">
	{@render palette(theme.preview.day, t('appearance_day', { name: theme.name }), true)}
	{@render palette(theme.preview.night, t('appearance_night', { name: theme.name }), false)}
</div>
