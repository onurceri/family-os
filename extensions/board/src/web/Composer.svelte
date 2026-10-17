<script lang="ts">
	import { Button } from '@famos/ui/button';
	import { Textarea } from '@famos/ui/textarea';
	import { addDays, formatDate, todayIn } from '@famos/time';
	import { Check, ImagePlus, X } from '@lucide/svelte';
	import { onDestroy, onMount } from 'svelte';
	import { type BoardNote, NOTE_MAX_CHARS, type Paper } from '../contract/index.js';
	import { editNote, postNote, uploadPhoto } from './data.js';
	import { useBoard } from './i18n.js';
	import { endOfWeek, NOTE_PAPERS, PAPER_CLASS } from './paper.js';
	import { resizeForNote } from './resize.js';

	/**
	 * The paper being written, in place of the empty tile (or of the note being changed). Putting
	 * it up is one action; the photo follows as an upload, shrunk in the browser first (which also
	 * drops camera metadata, since notes show on wall displays).
	 */
	let {
		note,
		ondone,
		oncancel,
	}: {
		/** Given when changing a note; the form then starts from it. */
		note?: BoardNote;
		ondone: () => void;
		oncancel: () => void;
	} = $props();
	const { app, t } = useBoard();

	type Until = 'none' | 'today' | 'tomorrow' | 'week' | 'pick';
	const today = $derived(todayIn(app.timeZone(), Date.now()));
	const weekEnd = $derived(endOfWeek(today, app.weekStart()));
	// "This week" is offered only when it is later than tomorrow; otherwise it repeats an option.
	const weekUseful = $derived(weekEnd > addDays(today, 1));

	// svelte-ignore state_referenced_locally
	let text = $state(note?.text ?? '');
	// svelte-ignore state_referenced_locally
	let paper = $state<Paper>(note?.paper ?? 'note-1');
	// svelte-ignore state_referenced_locally
	let until = $state<Until>(note?.endsOn ? 'pick' : 'none');
	// svelte-ignore state_referenced_locally
	let pickedDate = $state(note?.endsOn ?? '');
	let pinned = $state(false);
	let photo = $state<File | null>(null);
	let previewUrl = $state<string | null>(null);
	let busy = $state(false);
	let textarea = $state<HTMLTextAreaElement | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);
	const id = `board-${Math.random().toString(36).slice(2, 8)}`;

	onMount(() => textarea?.focus());
	onDestroy(() => previewUrl && URL.revokeObjectURL(previewUrl));

	const endsOn = $derived.by((): string | null => {
		if (until === 'today') return today;
		if (until === 'tomorrow') return addDays(today, 1);
		if (until === 'week') return weekEnd;
		if (until === 'pick') return pickedDate || null;
		return null;
	});
	const valid = $derived(
		text.trim().length > 0 &&
			text.length <= NOTE_MAX_CHARS &&
			(until !== 'pick' || (pickedDate !== '' && pickedDate >= today)),
	);

	function choosePhoto(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0] ?? null;
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		photo = file;
		previewUrl = file ? URL.createObjectURL(file) : null;
	}
	function dropPhoto() {
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		photo = null;
		previewUrl = null;
		if (fileInput) fileInput.value = '';
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!valid || busy) return;
		busy = true;
		try {
			let noteId = note?.id ?? null;
			if (note) {
				await editNote({ id: note.id, text: text.trim(), paper, endsOn });
			} else {
				noteId = await postNote({
					text: text.trim(),
					paper,
					...(pinned && { pinned: true }),
					...(endsOn && { endsOn }),
				});
			}
			if (photo && noteId) {
				try {
					await uploadPhoto(noteId, await resizeForNote(photo));
				} catch {
					app.toast(t('photo_failed'));
					ondone();
					return;
				}
			}
			app.toast(note ? t('saved') : t('posted'));
			ondone();
		} catch {
			app.toast(t('error'));
		} finally {
			busy = false;
		}
	}

	/** Each swatch sits a little askew, like a stack of papers to pick from. */
	const SWATCH_TILT = [-2, 1.5, -1, 2, -1.5];

	const field =
		'text-note-ink border-note-ink-soft/50 focus-visible:ring-ring h-11 w-full min-w-0 rounded-md border bg-transparent px-2 text-base focus-visible:ring-2 focus-visible:outline-none';
</script>

<form
	onsubmit={submit}
	class="paper day {PAPER_CLASS[paper]} text-note-ink grid grid-cols-1 gap-3 p-3"
	style:--paper="var(--{paper})"
	aria-label={note ? t('edit') : t('write_tile')}
	data-testid="composer"
>
	<label class="grid gap-1">
		<span class="sr-only">{t('note_label')}</span>
		<Textarea
			bind:ref={textarea}
			bind:value={text}
			maxlength={NOTE_MAX_CHARS}
			rows={4}
			placeholder={t('note_placeholder')}
			class="text-note-ink placeholder:text-note-ink-soft focus-visible:ring-ring min-h-28 w-full resize-y rounded-sm bg-transparent text-base leading-snug font-semibold focus-visible:ring-2 focus-visible:outline-none"
			data-testid="composer-text"
		></Textarea>
	</label>

	<fieldset class="min-w-0">
		<legend class="text-note-ink-soft mb-1.5 text-xs font-semibold">{t('paper_group')}</legend>
		<div class="grid grid-cols-5 gap-2">
			{#each NOTE_PAPERS as option, i (option)}
				<label class="min-w-0 cursor-pointer" style:--tilt="{SWATCH_TILT[i]}deg">
					<input
						type="radio"
						name="{id}-paper"
						value={option}
						checked={paper === option}
						onchange={() => (paper = option)}
						class="peer sr-only"
					/>
					<span
						style:--swatch="var(--{option})"
						class="swatch {PAPER_CLASS[
							option
						]} text-note-ink peer-checked:outline-note-ink peer-focus-visible:ring-ring grid h-12 place-items-center rounded-sm peer-checked:outline-[2.5px] peer-checked:outline-offset-2 peer-focus-visible:ring-2"
					>
						{#if paper === option}<Check class="size-5" aria-hidden="true" />{/if}
					</span>
					<span class="sr-only">{t('paper_n', { n: i + 1 })}</span>
				</label>
			{/each}
		</div>
	</fieldset>

	<div class="flex flex-wrap items-center gap-2">
		<input
			bind:this={fileInput}
			type="file"
			accept="image/*"
			class="sr-only"
			tabindex="-1"
			aria-hidden="true"
			id="{id}-photo"
			onchange={choosePhoto}
			data-testid="composer-photo"
		/>
		<button
			type="button"
			class="text-note-ink border-note-ink-soft/50 hover:bg-note-ink/10 flex min-h-11 max-w-full items-center gap-2 rounded-lg border px-3 text-sm font-bold"
			onclick={() => fileInput?.click()}
		>
			<ImagePlus class="size-4" aria-hidden="true" />
			{photo || note?.hasPhoto ? t('change_photo') : t('add_photo')}
		</button>
		{#if previewUrl}
			<span class="relative">
				<img src={previewUrl} alt={t('photo_chosen')} class="size-11 rounded-md object-cover" />
				<button
					type="button"
					class="bg-surface text-ink shadow-lit absolute -end-2 -top-2 grid size-6 place-items-center rounded-full after:absolute after:-inset-2.5 after:content-['']"
					aria-label={t('remove_photo')}
					onclick={dropPhoto}
				>
					<X class="size-3.5" aria-hidden="true" />
				</button>
			</span>
		{/if}
	</div>

	<div class="grid gap-1.5">
		<label for="{id}-until" class="text-note-ink-soft text-xs font-semibold"
			>{t('until_label')}</label
		>
		<select id="{id}-until" bind:value={until} class={field} data-testid="composer-until">
			<option value="none">{t('until_none')}</option>
			<option value="today">{t('until_today')}</option>
			<option value="tomorrow">{t('until_tomorrow')}</option>
			{#if weekUseful}<option value="week">{t('until_week')}</option>{/if}
			<option value="pick">{t('until_pick')}</option>
		</select>
		{#if until === 'pick'}
			<label for="{id}-date" class="sr-only">{t('until_date_label')}</label>
			<input
				id="{id}-date"
				type="date"
				min={today}
				bind:value={pickedDate}
				class={field}
				data-testid="composer-date"
			/>
		{:else if endsOn}
			<small class="text-note-ink-soft text-xs"
				>{formatDate(endsOn, app.dateLocale(), {
					weekday: 'long',
					day: 'numeric',
					month: 'long',
				})}</small
			>
		{/if}
	</div>

	{#if !note && app.access('board.pinNote') !== 'no'}
		<label class="flex min-h-11 items-center gap-2 text-sm font-bold">
			<input type="checkbox" bind:checked={pinned} class="size-5" data-testid="composer-pin" />
			{t('pin_label')}
		</label>
	{/if}

	<div class="flex flex-wrap gap-2">
		<Button type="submit" size="lg" disabled={!valid || busy} data-testid="composer-submit"
			>{note ? t('save') : t('put_up')}</Button
		>
		<Button type="button" size="lg" variant="ghost" class="text-note-ink" onclick={oncancel}
			>{t('cancel')}</Button
		>
	</div>
</form>

<style>
	.swatch {
		box-shadow:
			var(--shadow-lit),
			0 4px 8px -5px color-mix(in srgb, var(--note-ink) 45%, transparent);
		transform: rotate(var(--tilt));
	}
	@media (prefers-contrast: more) {
		.swatch {
			transform: none;
		}
	}
	/* The paper being written is a day paper, as the notes on the board are; by night it is
	   dimmed a little toward the lamp-lit cork (`--lamp`, set by the board). */
	.paper {
		color-scheme: light;
	}
	:global(.dark) .paper {
		background-color: color-mix(in srgb, var(--paper) 84%, var(--lamp, var(--board)));
	}
	/* The softer ink leans toward the ink by night, so it keeps 4.5:1 on the dimmed paper. */
	:global(.dark) .paper :global(.text-note-ink-soft),
	:global(.dark) .paper :global(textarea::placeholder) {
		color: color-mix(in srgb, var(--note-ink-soft) 60%, var(--note-ink));
	}
	:global(.dark) .swatch {
		background-color: color-mix(in srgb, var(--swatch) 84%, var(--lamp, var(--board)));
	}
	.paper {
		border-radius: var(--radius-sm);
		box-shadow:
			var(--shadow-lit),
			0 6px 12px -7px color-mix(in srgb, var(--note-ink) 45%, transparent);
	}
</style>
