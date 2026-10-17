<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Button } from '@famos/ui/button';
	import { STYLES } from '@famos/ui/styles';
	import { Eye } from '@lucide/svelte';
	import { appearance } from '#lib/appearance.svelte.js';
	import { t } from '#lib/i18n.svelte.js';
	import { toasts } from '#lib/toast.svelte.js';

	/**
	 * What this person is trying (Settings → Appearance), on every page until they
	 * decide: "Trying Lanes · Forest" with Use for me, Keep looking (back to Appearance) and Stop.
	 * A theme tried as the family's default has its own bar on Family → Family look and is left out.
	 * It sits above the phone tab bar, and at the foot of the content column from 768 px.
	 */
	const APPEARANCE = '/settings/appearance';

	const theme = $derived(
		appearance.previewing === null || appearance.previewingForFamily
			? null
			: (appearance.themes.find((th) => th.id === appearance.previewing)?.name ??
					appearance.previewing),
	);
	const style = $derived(
		appearance.previewingStyle ? t(STYLES[appearance.previewingStyle].nameKey) : null,
	);
	const trying = $derived([style, theme].filter((name) => name !== null).join(' · '));
	let saving = $state(false);
	let bar = $state<HTMLDivElement>();

	/** Phones: the toast lifts above this bar (`--preview-bar-height` on the root while shown). */
	$effect(() => {
		const node = bar;
		if (!trying || !node) return;
		const root = document.documentElement;
		const sync = () => root.style.setProperty('--preview-bar-height', `${node.offsetHeight}px`);
		const observer = new ResizeObserver(sync);
		observer.observe(node);
		sync();
		return () => {
			observer.disconnect();
			root.style.removeProperty('--preview-bar-height');
		};
	});

	async function use() {
		saving = true;
		try {
			await appearance.useTried();
			toasts.show(t('appearance_saved'));
		} catch {
			toasts.show(t('error_generic'));
		} finally {
			saving = false;
		}
	}

	/** Back to this person's own choice; a theme tried for the family stays with its page. */
	function stop() {
		appearance.endStylePreview();
		if (!appearance.previewingForFamily) appearance.endPreview();
	}
</script>

{#if trying}
	<div
		bind:this={bar}
		class="pointer-events-none fixed inset-x-0 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-40 px-3 md:bottom-5 md:ps-[calc(5rem+1rem)] md:pe-4 lg:ps-[calc(15.5rem+2.5rem)] lg:pe-10"
	>
		<div
			class="bg-surface shadow-pop pointer-events-auto mx-auto flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[var(--r-card)] border py-2 ps-4 pe-2"
			role="status"
			data-testid="theme-preview-bar"
		>
			<span class="flex min-w-0 flex-1 basis-48 items-center gap-2 text-[15px] font-bold">
				<Eye class="text-info size-4 shrink-0" aria-hidden="true" />
				<span class="truncate">{t('appearance_trying', { name: trying })}</span>
			</span>
			<span class="ms-auto flex items-center gap-1">
				<Button type="button" size="sm" disabled={saving} onclick={use}
					>{t('appearance_use')}</Button
				>
				{#if page.url.pathname !== APPEARANCE}
					<Button type="button" size="sm" variant="ghost" onclick={() => goto(APPEARANCE)}
						>{t('appearance_keep_looking')}</Button
					>
				{/if}
				<Button type="button" size="sm" variant="ghost" onclick={stop}
					>{t('appearance_preview_end')}</Button
				>
			</span>
		</div>
	</div>
{/if}
