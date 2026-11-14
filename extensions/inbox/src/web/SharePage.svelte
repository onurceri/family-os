<script lang="ts">
	import { isApiError } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import { Page } from '@famos/ui/famos';
	import { FileText, LoaderCircle } from '@lucide/svelte';
	import CaptureGroup from './CaptureGroup.svelte';
	import { type FileChoice, sendItem } from './data.js';
	import { CaptureFeed } from './feed.svelte.js';
	import FileTargetPicker from './FileTargetPicker.svelte';
	import { useInbox } from './i18n.js';

	/**
	 * Share target landing page. The service worker stored the shared title, text, link and files
	 * in a cache (same names as in apps/web/src/service-worker). This page shows what arrived and
	 * sends it only on a tap: a share-target POST can come from any site, so nothing reaches
	 * Quick add without the person seeing it first. After the tap the page stays and follows the
	 * capture: Reading…, its suggestions, Add selected.
	 */
	const SHARE_CACHE = 'famos-share-target';
	const META = '/__share/meta';
	type Shared = {
		title: string | null;
		text: string | null;
		url: string | null;
		files: { key: string; name: string; type: string }[];
	};
	type Preview = { file: File; src: string | null };

	const { app, t } = useInbox();
	const feed = new CaptureFeed(app);
	let phase = $state<'loading' | 'ready' | 'sending' | 'empty' | 'failed' | 'sent'>('loading');
	let sentId = $state<string | null>(null);
	const sentCapture = $derived(sentId ? feed.capture(sentId) : undefined);
	$effect(() => (phase === 'sent' ? feed.start() : undefined));
	let shared = $state<Shared | null>(null);
	let previews = $state<Preview[]>([]);
	let quota = $state(false);
	let fileTo = $state<FileChoice | null>(null);

	async function load() {
		try {
			await read();
		} catch {
			phase = 'failed';
		}
	}

	async function read() {
		const cache = await caches.open(SHARE_CACHE);
		const meta = await cache.match(META);
		if (!meta) {
			phase = 'empty';
			return;
		}
		const data = (await meta.json()) as Shared;
		const loaded: Preview[] = [];
		for (const f of data.files) {
			const blob = await (await cache.match(f.key))?.blob();
			if (!blob) continue;
			const file = new File([blob], f.name, { type: f.type });
			loaded.push({ file, src: f.type.startsWith('image/') ? URL.createObjectURL(file) : null });
		}
		shared = data;
		previews = loaded;
		phase = 'ready';
	}

	async function clear() {
		const cache = await caches.open(SHARE_CACHE);
		await Promise.all([
			cache.delete(META),
			...(shared?.files ?? []).map((f) => cache.delete(f.key)),
		]);
	}

	async function send() {
		if (!shared) return;
		phase = 'sending';
		try {
			const item = await sendItem({
				channel: 'share',
				...(shared.title && { title: shared.title }),
				...(shared.text && { text: shared.text }),
				...(shared.url && { url: shared.url }),
				files: previews.map((p) => p.file),
				...(fileTo && previews.length > 0 && { fileTo }),
			});
			await clear();
			feed.add(item);
			sentId = item.id;
			phase = 'sent';
		} catch (error) {
			quota = isApiError(error) && error.code === 'limit_reached';
			phase = 'failed';
		}
	}

	async function cancel() {
		await clear();
		location.replace('/');
	}

	$effect(() => {
		void load();
		return () => {
			for (const p of previews) if (p.src) URL.revokeObjectURL(p.src);
		};
	});
</script>

<Page template="capture" title={t('share_title')}>
	{#if phase === 'loading'}
		<LoaderCircle class="size-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
	{:else if phase === 'empty'}
		<p class="bg-idle text-ink-soft rounded-xl px-4 py-6">{t('share_empty')}</p>
	{:else if phase === 'sent'}
		<div class="grid max-w-2xl gap-4">
			{#if sentCapture}
				<CaptureGroup capture={sentCapture} onchanged={() => void feed.load()} />
			{:else}
				<LoaderCircle class="size-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
			{/if}
			<Button href="/add" variant="outline" class="justify-self-start">{t('open_quick_add')}</Button
			>
		</div>
	{:else if phase === 'failed' && !shared}
		<p class="text-attention font-semibold" role="alert">{t('share_load_failed')}</p>
		<Button variant="outline" class="justify-self-start" onclick={cancel}
			>{t('share_cancel')}</Button
		>
	{:else if shared}
		<section
			class="bg-surface shadow-lit grid gap-3 rounded-xl p-4"
			aria-label={t('share_preview')}
		>
			{#if shared.title}<p class="font-extrabold break-words">{shared.title}</p>{/if}
			{#if shared.text}<p class="break-words whitespace-pre-line">{shared.text}</p>{/if}
			{#if shared.url}<p class="text-ink-soft text-sm break-all">{shared.url}</p>{/if}
			{#if previews.length > 0}
				<ul class="flex flex-wrap gap-2">
					{#each previews as p (p.file.name + p.file.size)}
						<li class="bg-idle flex items-center gap-2 rounded-lg p-2 text-sm">
							{#if p.src}
								<img src={p.src} alt={p.file.name} class="size-16 rounded object-cover" />
							{:else}
								<FileText class="size-5" aria-hidden="true" />
								<span class="max-w-48 truncate">{p.file.name}</span>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>
		<p class="text-ink-soft text-sm">
			{fileTo ? t('share_filing_hint') : t('share_confirm_hint')}
		</p>
		{#if previews.length > 0}<FileTargetPicker bind:value={fileTo} />{/if}
		{#if phase === 'failed'}
			<p class="text-attention font-semibold" role="alert">
				{quota ? t('quota') : t('share_failed')}
			</p>
		{/if}
		<div class="flex flex-wrap gap-2">
			<Button onclick={send} disabled={phase === 'sending'}>
				{#if phase === 'sending'}
					<LoaderCircle class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
					{t('share_sending')}
				{:else if phase === 'failed'}
					{t('share_retry')}
				{:else if fileTo}
					{t('share_file')}
				{:else}
					{t('share_send')}
				{/if}
			</Button>
			<Button variant="ghost" onclick={cancel} disabled={phase === 'sending'}
				>{t('share_cancel')}</Button
			>
		</div>
	{/if}
</Page>
