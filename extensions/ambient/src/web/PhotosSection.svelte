<script lang="ts">
	import { Button } from '@famos/ui/button';
	import { Card, ConfirmButton, resizeImage, Section } from '@famos/ui/famos';
	import { Camera } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import type { LibraryPhoto } from '../contract/index.js';
	import { deletePhoto, loadLibrary, photoUrl, uploadPhoto } from './data.js';
	import { useAmbient } from './i18n.js';

	/** Settings → Photos and weather: the photos displays show in ambient mode. */
	const { app, t } = useAmbient();
	/** The longest side of a display photo; a wall screen needs no more. */
	const DISPLAY_PHOTO_SIDE = 1920;

	let photos = $state<LibraryPhoto[]>([]);
	let loaded = $state(false);
	let loadFailed = $state(false);
	/** Progress of the current upload: which file of how many. */
	let progress = $state<{ done: number; total: number } | null>(null);
	let input = $state<HTMLInputElement | null>(null);

	async function refresh() {
		try {
			photos = await loadLibrary();
			loadFailed = false;
		} catch {
			loadFailed = true;
		} finally {
			loaded = true;
		}
	}
	onMount(() => void refresh());

	async function onChoose(event: Event) {
		const files = Array.from((event.currentTarget as HTMLInputElement).files ?? []);
		if (files.length === 0) return;
		let failed = 0;
		progress = { done: 0, total: files.length };
		for (const file of files) {
			try {
				const resized = await resizeImage(file, DISPLAY_PHOTO_SIDE);
				await uploadPhoto(resized, `${file.name.replace(/\.[^.]*$/, '') || 'photo'}.jpg`);
			} catch {
				failed++;
			}
			progress = { done: (progress?.done ?? 0) + 1, total: files.length };
		}
		progress = null;
		if (input) input.value = '';
		await refresh();
		if (failed > 0) app.toast(t('photos_failed', { count: failed }));
		else app.toast(t('photos_added', { count: files.length }));
	}

	async function remove(id: string) {
		try {
			await deletePhoto(id);
			photos = photos.filter((p) => p.id !== id);
			app.toast(t('photo_removed'));
		} catch {
			app.toast(t('error'));
		}
	}

	const uploading = $derived(progress !== null);
</script>

<Section label={t('photos_title')} count={loaded ? photos.length : undefined}>
	{#snippet actions()}
		<label
			class="text-ink-soft hover:bg-idle hover:text-ink focus-within:ring-info inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-[var(--r-ctl)] px-2.5 text-[13px] font-semibold focus-within:ring-2 {uploading
				? 'opacity-50'
				: ''}"
		>
			<Camera class="size-4" aria-hidden="true" />
			{t('photos_add')}
			<input
				bind:this={input}
				type="file"
				accept="image/*"
				multiple
				class="sr-only"
				disabled={uploading}
				onchange={onChoose}
				aria-label={t('photos_input')}
			/>
		</label>
	{/snippet}
	<p class="text-ink-soft px-1 text-[13px]">{t('photos_intro')} {t('photos_hint')}</p>
	{#if progress}
		<p class="text-ink-soft px-1 text-sm font-semibold" role="status">
			{t('photos_uploading', { done: progress.done, total: progress.total })}
		</p>
	{/if}

	{#if loadFailed}
		<p class="text-attention text-sm font-semibold" role="alert">{t('error')}</p>
		<div>
			<Button type="button" variant="outline" onclick={refresh}>{t('retry')}</Button>
		</div>
	{:else if loaded && photos.length === 0}
		<Card variant="quiet" pad>
			<p class="text-ink-soft text-sm" data-testid="photos-empty">{t('photos_none')}</p>
		</Card>
	{:else}
		<ul
			class="grid grid-cols-2 gap-3 @sm:grid-cols-3"
			aria-label={t('photos_title')}
			data-testid="photo-grid"
		>
			{#each photos as photo (photo.id)}
				<li class="bg-idle grid overflow-hidden rounded-[var(--r-item)]">
					<img
						src={photoUrl(photo.id)}
						alt=""
						loading="lazy"
						width={photo.width}
						height={photo.height}
						class="aspect-square w-full object-cover"
					/>
					<div class="flex justify-end p-1">
						<ConfirmButton
							label={t('photo_remove')}
							confirmLabel={t('photo_remove_confirm')}
							onconfirm={() => remove(photo.id)}
						/>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</Section>
