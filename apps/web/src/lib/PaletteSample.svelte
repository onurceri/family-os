<script lang="ts">
	import { useApp } from '@famos/ui/app';
	import { Button } from '@famos/ui/button';
	import { Avatar, Chip, Pill, Row } from '@famos/ui/famos';
	import { Check } from '@lucide/svelte';
	import { t } from '#lib/i18n.svelte.js';
	import { family } from '#lib/family.svelte.js';
	import { samplePeople } from '#lib/today/sample-people.js';

	/**
	 * The colors at work (Settings → Appearance): the real components with a made-up day
	 * (the hero on `accent`, a row, a button, chips and a pill), drawn in the palette on screen, so
	 * a tried theme shows at once. It is a picture: inert and hidden from assistive technology
	 * (`name` says which colors it shows). The people are the family's own, as in the style previews.
	 */
	let { name }: { name: string } = $props();

	const app = useApp();
	const [first, second] = $derived(samplePeople(family.members, t, app.me()?.id));
</script>

<figure class="grid gap-2" data-testid="palette-sample">
	<div
		class="bg-wall grid gap-3 rounded-[var(--r-card)] p-3 shadow-[inset_0_0_0_1px_var(--line)] @xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]"
		inert
		aria-hidden="true"
	>
		<div class="bg-accent text-on-accent grid content-start gap-1.5 rounded-[var(--r-card)] p-4">
			<span class="text-[11px] font-bold tracking-[0.08em] uppercase opacity-80"
				>{t('today_next_up')} · {first.displayName}</span
			>
			<span class="font-serif text-[22px] leading-tight font-bold"
				>{t('appearance_sample_piano')}</span
			>
			<span class="text-sm font-semibold opacity-85">{t('appearance_sample_music_school')}</span>
		</div>
		<div class="grid content-start gap-2.5">
			<div class="bg-surface shadow-lit rounded-[var(--r-card)] px-1">
				<Row title={t('appearance_sample_dentist')} meta={second.displayName}>
					{#snippet lead()}<Avatar
							name={second.displayName}
							color={second.color}
							size={28}
						/>{/snippet}
					{#snippet trail()}<Pill tone="now"
							>{#snippet icon()}<Check aria-hidden="true" />{/snippet}{t(
								'appearance_sample_done',
							)}</Pill
						>{/snippet}
				</Row>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<Button type="button" size="sm" variant="secondary">{t('appearance_use')}</Button>
				<Chip on>{first.displayName}</Chip>
				<Chip>{second.displayName}</Chip>
				<Pill tone="attention">{t('appearance_sample_library')}</Pill>
			</div>
		</div>
	</div>
	<figcaption class="text-ink-soft px-1 text-xs">
		{t('appearance_palette_sample', { name })}
	</figcaption>
</figure>
