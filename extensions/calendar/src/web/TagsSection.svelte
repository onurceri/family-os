<script lang="ts">
	import {
		Card,
		ConfirmButton,
		FIELD_REASON,
		FieldError,
		fieldAria,
		focusFirstInvalid,
		Row,
		Section,
		SidePanel,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { ChevronRight } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { MAX_TAG_LENGTH, type Tag } from '../contract/index.js';
	import ColorChoice from './ColorChoice.svelte';
	import { deleteTag, loadTags, updateTag } from './data.js';
	import { useCalendar } from './i18n.js';
	import LoadFailed from './LoadFailed.svelte';
	import { readList } from './reload-list.js';
	import TagChip from './TagChip.svelte';

	/** "Tags": rename, recolour or delete the family's calendar tags. Needs the right to edit events. */
	const { t } = useCalendar();

	let tags = $state<Tag[]>([]);
	let loaded = $state(false);

	/** A read that failed keeps the list on screen and is never taken for an empty one. */
	let loadFailed = $state(false);
	async function load() {
		const read = await readList(loadTags, tags);
		tags = read.list;
		loadFailed = !read.ok;
		if (read.ok) loaded = true;
	}
	onMount(() => void load());

	let editing = $state<string | null>(null);
	let editName = $state('');
	let editColor = $state('');
	let busy = $state(false);
	let failed = $state(false);
	let formEl = $state<HTMLFormElement>();
	// Why Save is refused, shown after the first press; the button itself stays pressable.
	let showErrors = $state(false);
	const nameError = $derived(editName.trim() ? undefined : FIELD_REASON.name);

	function startEdit(tag: Tag) {
		editing = tag.name;
		editName = tag.name;
		editColor = tag.color;
		failed = false;
		showErrors = false;
	}
	const current = $derived(tags.find((x) => x.name === editing));

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (editing === null) return;
		showErrors = true;
		if (nameError) {
			void focusFirstInvalid(formEl);
			return;
		}
		busy = true;
		failed = false;
		try {
			await updateTag({ name: editing, newName: editName.trim(), color: editColor });
			editing = null;
			await load();
		} catch {
			failed = true;
		} finally {
			busy = false;
		}
	}

	async function remove(tag: Tag) {
		try {
			await deleteTag(tag.name);
			editing = null;
			await load();
		} catch {
			failed = true;
		}
	}
</script>

<Section label={t('tags_title')} count={loaded ? tags.length : undefined}>
	<p class="text-ink-soft max-w-prose px-1 text-[13px]">{t('tags_intro')}</p>
	{#if loaded}
		{#if tags.length > 0}
			<Card rows>
				{#each tags as tag (tag.name)}
					<Row title={tag.name} onclick={() => startEdit(tag)} aria-label={tag.name}>
						{#snippet lead()}
							<span
								class="block size-3 rounded-full"
								style:background-color={tag.color}
								aria-hidden="true"
							></span>
						{/snippet}
						{#snippet trail()}<ChevronRight
								class="text-ink-soft size-4"
								aria-hidden="true"
							/>{/snippet}
					</Row>
				{/each}
			</Card>
		{:else}
			<Card variant="quiet" pad><p class="text-ink-soft text-sm">{t('tags_none')}</p></Card>
		{/if}
	{/if}
	{#if loadFailed}<LoadFailed onretry={load} />{/if}
	{#if failed && editing === null}<p class="text-attention text-sm font-semibold" role="alert">
			{t('error')}
		</p>{/if}
</Section>

<SidePanel
	open={editing !== null}
	title={t('tag_edit_title', { name: editing ?? '' })}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={t('save')}
	saveDisabled={busy}
	onsave={() => formEl?.requestSubmit()}
	onclose={() => (editing = null)}
	dirty={current !== undefined && (editName !== current.name || editColor !== current.color)}
	discard={{
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	}}
>
	{#snippet danger()}
		{#if current}
			<ConfirmButton
				label={t('tag_delete')}
				confirmLabel={t('tag_delete_confirm')}
				onconfirm={() => remove(current)}
			/>
		{/if}
	{/snippet}
	<form
		class="grid gap-5"
		bind:this={formEl}
		onsubmit={save}
		aria-label={t('tag_edit_title', { name: editing ?? '' })}
	>
		{#if current}
			<p class="text-base"><TagChip name={current.name} color={current.color} /></p>
		{/if}
		<div class="grid gap-1.5">
			<Label for="tag-name">{t('tag_name')}</Label>
			<Input
				id="tag-name"
				bind:value={editName}
				maxlength={MAX_TAG_LENGTH}
				{...fieldAria(showErrors ? nameError : undefined, 'tag-name')}
			/>
			<FieldError for="tag-name" error={showErrors ? nameError : undefined} />
			<p class="text-ink-soft text-[13px]">{t('tag_rename_hint')}</p>
		</div>
		<ColorChoice bind:value={editColor} name="tag-color" legend={t('sub_color')} />
		{#if failed}<p class="text-attention text-sm font-semibold" role="alert">{t('error')}</p>{/if}
	</form>
</SidePanel>
