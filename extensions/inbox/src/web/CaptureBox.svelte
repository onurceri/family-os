<script lang="ts">
	import { isApiError } from '@famos/api-client';
	import { LimitCounter, lengthState } from '@famos/ui/famos';
	import { ArrowUp, Mic, Paperclip, Square, X } from '@lucide/svelte';
	import { onDestroy } from 'svelte';
	import { type InboxItem, UPLOAD_LIMITS } from '../contract/index.js';
	import { type FileChoice, sendItem } from './data.js';
	import FileTargetPicker from './FileTargetPicker.svelte';
	import { useInbox } from './i18n.js';
	import { addFiles, dragHasFiles } from './ways.js';

	/**
	 * The one box of Quick add: paste or type, attach (or drop, or paste) photos and files, record
	 * a voice note, and **Send**. Not a chat: it sends one capture and clears itself. `hero` is
	 * the Quick add page's large card; `compact` the side panel's.
	 */
	let {
		onsent,
		id = 'quick-add-text',
		compact = false,
		hero = false,
	}: {
		onsent: (item: InboxItem) => void;
		/** The id of the text area, so a button elsewhere can focus it. */
		id?: string;
		compact?: boolean;
		hero?: boolean;
	} = $props();
	const { app, t } = useInbox();

	let text = $state('');
	let files = $state<File[]>([]);
	let sending = $state(false);
	let picker = $state<HTMLInputElement | null>(null);
	let area = $state<HTMLTextAreaElement | null>(null);
	let fileTo = $state<FileChoice | null>(null);

	// The box grows with what is typed, up to about a third of the window.
	$effect(() => {
		void text;
		if (!area) return;
		area.style.height = 'auto';
		area.style.height = `${area.scrollHeight}px`;
	});

	function take(incoming: Iterable<File>) {
		const next = addFiles(files, incoming, UPLOAD_LIMITS.accept, UPLOAD_LIMITS.maxFiles);
		files = next.files;
		if (next.refused > 0)
			app.toast(t('files_refused', { count: next.refused, max: UPLOAD_LIMITS.maxFiles }));
	}

	function pick(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		take(Array.from(input.files ?? []));
		input.value = '';
	}

	// A photo pasted from the clipboard joins the files; pasted text stays text.
	function onpaste(event: ClipboardEvent) {
		const pasted = Array.from(event.clipboardData?.files ?? []);
		if (pasted.length === 0) return;
		event.preventDefault();
		take(pasted);
	}

	// Dropping files on the card. The counter survives the dragenter/dragleave pairs of children.
	let dragDepth = $state(0);
	const dragging = $derived(dragDepth > 0);
	function ondragenter(event: DragEvent) {
		if (!dragHasFiles(Array.from(event.dataTransfer?.types ?? []))) return;
		event.preventDefault();
		dragDepth += 1;
	}
	function ondragover(event: DragEvent) {
		if (!dragHasFiles(Array.from(event.dataTransfer?.types ?? []))) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
	}
	function ondragleave() {
		if (dragDepth > 0) dragDepth -= 1;
	}
	function ondrop(event: DragEvent) {
		if (!dragHasFiles(Array.from(event.dataTransfer?.types ?? []))) return;
		event.preventDefault();
		dragDepth = 0;
		take(Array.from(event.dataTransfer?.files ?? []));
	}

	// Voice: a short recording becomes an audio file like any other attachment, so the same
	// limits apply and the server turns it into text (inbox.transcribe).
	const canRecord =
		typeof navigator !== 'undefined' &&
		Boolean(navigator.mediaDevices?.getUserMedia) &&
		typeof MediaRecorder !== 'undefined';
	let recording = $state(false);
	let seconds = $state(0);
	let recorder: MediaRecorder | null = null;
	let stream: MediaStream | null = null;
	let ticker: ReturnType<typeof setInterval> | undefined;

	function releaseMicrophone() {
		clearInterval(ticker);
		for (const track of stream?.getTracks() ?? []) track.stop();
		stream = null;
		recorder = null;
		recording = false;
	}

	async function toggleRecording() {
		if (recording) {
			recorder?.stop();
			return;
		}
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const chunks: Blob[] = [];
			const next = new MediaRecorder(stream);
			recorder = next;
			next.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
			next.onstop = () => {
				const type = next.mimeType || 'audio/webm';
				const extension = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
				if (chunks.length > 0 && files.length < UPLOAD_LIMITS.maxFiles)
					files = [
						...files,
						new File(chunks, `${t('voice_note')}.${extension}`, { type: type.split(';')[0] }),
					];
				releaseMicrophone();
			};
			seconds = 0;
			ticker = setInterval(() => (seconds += 1), 1000);
			next.start();
			recording = true;
		} catch {
			releaseMicrophone();
			app.toast(t('voice_unavailable'));
		}
	}
	onDestroy(() => {
		if (recording) releaseMicrophone();
	});

	const clock = $derived(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
	const empty = $derived(!text.trim() && files.length === 0);
	const TEXT_MAX = 20000;
	const over = $derived(lengthState(text, TEXT_MAX).over);
	const ready = $derived(!empty && !recording && !over);
	const sendLabel = $derived(fileTo && files.length > 0 ? t('share_file') : t('send'));

	async function send(event: SubmitEvent) {
		event.preventDefault();
		if (empty || sending || recording || over) return;
		sending = true;
		try {
			const item = await sendItem({
				channel: files.length ? 'upload' : 'text',
				text: text.trim() || undefined,
				files,
				...(fileTo && files.length > 0 && { fileTo }),
			});
			text = '';
			files = [];
			fileTo = null;
			onsent(item);
		} catch (error) {
			app.toast(isApiError(error) && error.code === 'limit_reached' ? t('quota') : t('error'));
		} finally {
			sending = false;
		}
	}

	function onkeydown(event: KeyboardEvent) {
		// Ctrl or Cmd + Enter sends, like most capture boxes; plain Enter is a new line.
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			(event.currentTarget as HTMLElement).closest('form')?.requestSubmit();
		}
	}
</script>

<form
	onsubmit={send}
	{ondragenter}
	{ondragover}
	{ondragleave}
	{ondrop}
	class="box bg-surface @container relative grid gap-2 {hero
		? 'shadow-pop min-h-[180px] rounded-[24px] p-3 sm:p-4'
		: 'shadow-lit rounded-[20px] p-3'}"
	class:dragging
	data-testid="capture-box"
>
	<label for={id} class="sr-only">{t('compose_label')}</label>
	<textarea
		{id}
		bind:this={area}
		bind:value={text}
		rows={compact ? 2 : 3}
		placeholder={t('compose_placeholder')}
		{onkeydown}
		{onpaste}
		class="placeholder:text-ink-soft max-h-viewport-40 w-full resize-none bg-transparent px-2 pt-1.5 outline-none placeholder:font-serif placeholder:italic {hero
			? 'min-h-28 text-lg leading-8 placeholder:text-xl sm:text-xl sm:placeholder:text-2xl'
			: compact
				? 'min-h-16 text-base leading-7 placeholder:text-lg'
				: 'min-h-20 text-[17px] leading-7 placeholder:text-xl'}"></textarea>
	<LimitCounter
		{text}
		max={TEXT_MAX}
		tooLong={(_, { length, max }) => app.t('app:too_long', { length, max })}
	/>
	{#if files.length}
		<ul class="flex flex-wrap gap-2 px-1">
			{#each files as file, i (i)}
				<li
					class="bg-idle flex min-h-9 max-w-full items-center gap-1 rounded-full pr-1 pl-3 text-sm font-semibold"
				>
					<span class="max-w-48 truncate">{file.name}</span>
					<button
						type="button"
						class="text-ink-soft hover:text-ink grid size-8 place-items-center rounded-full"
						aria-label={t('remove_file', { name: file.name })}
						onclick={() => (files = files.filter((_, j) => j !== i))}><X class="size-4" /></button
					>
				</li>
			{/each}
		</ul>
		<div class="px-1"><FileTargetPicker bind:value={fileTo} /></div>
	{/if}
	<div class="flex items-center gap-1 self-end">
		<input
			bind:this={picker}
			type="file"
			multiple
			accept={UPLOAD_LIMITS.accept.join(',')}
			class="hidden"
			onchange={pick}
		/>
		<button
			type="button"
			class="text-ink-soft hover:bg-idle hover:text-ink focus-visible:ring-ring flex h-11 min-w-11 items-center justify-center gap-2 rounded-full px-2.5 text-sm font-semibold outline-none focus-visible:ring-2"
			aria-label={t('attach')}
			onclick={() => picker?.click()}
		>
			<Paperclip class="size-5 shrink-0" aria-hidden="true" />
			<span class="hidden @md:inline" aria-hidden="true">{t('attach')}</span>
		</button>
		{#if canRecord}
			<button
				type="button"
				class="focus-visible:ring-ring grid size-11 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-2 {recording
					? 'bg-attention text-on-color'
					: 'text-ink-soft hover:bg-idle hover:text-ink'}"
				aria-label={recording ? t('record_stop') : t('record_start')}
				aria-pressed={recording}
				onclick={toggleRecording}
				>{#if recording}<Square class="size-4 fill-current" aria-hidden="true" />{:else}<Mic
						class="size-5"
						aria-hidden="true"
					/>{/if}</button
			>
		{/if}
		{#if recording}
			<span class="text-attention text-sm font-bold tabular-nums" role="status">
				{t('recording')}
				{clock}
			</span>
		{/if}
		{#if ready}
			<button
				type="submit"
				disabled={sending}
				class="bg-accent text-on-accent focus-visible:ring-ring ml-auto flex h-11 shrink-0 items-center gap-2 rounded-full pr-5 pl-4 text-[15px] font-bold outline-none focus-visible:ring-2 disabled:opacity-70"
			>
				<ArrowUp class="size-5" aria-hidden="true" />
				{sendLabel}
			</button>
		{:else}
			<!-- Nothing to read yet: a quiet round button, never a grey text button that looks broken. -->
			<button
				type="submit"
				disabled
				aria-label={sendLabel}
				class="bg-idle text-ink-soft ml-auto grid size-11 shrink-0 place-items-center rounded-full"
			>
				<ArrowUp class="size-5" aria-hidden="true" />
			</button>
		{/if}
	</div>
	{#if dragging}
		<div
			class="drop text-ink pointer-events-none absolute inset-0 grid place-items-center rounded-[inherit] text-lg font-bold"
			aria-hidden="true"
		>
			{t('drop_here')}
		</div>
	{/if}
</form>

<style>
	.box {
		transition: outline-color 120ms;
		outline: 2px dashed transparent;
		outline-offset: 3px;
	}
	.box.dragging {
		outline-color: var(--accent);
		animation: drop-pulse 1.4s ease-in-out infinite;
	}
	.drop {
		background: color-mix(in srgb, var(--accent) 14%, var(--surface));
	}
	@keyframes drop-pulse {
		50% {
			outline-offset: 6px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.box,
		.box.dragging {
			transition: none;
			animation: none;
		}
	}
</style>
