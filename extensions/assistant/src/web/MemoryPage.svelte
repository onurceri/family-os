<script lang="ts">
	import { Card, Composer, ConfirmButton, Page, PageHeader, SidePanel } from '@famos/ui/famos';
	import { ChevronRight } from '@lucide/svelte';
	import { addMemory, deleteMemory, loadMemories, type Memory, updateMemory } from './data.js';
	import { useAssistant } from './i18n.js';

	/**
	 * "Assistant memory", Settings, You: the member's own short notes. Only they can read
	 * them; the assistant shows them to the model in their own conversations. Add one in the field,
	 * change or forget one in a panel; notes the assistant suggests arrive as cards in the
	 * conversation.
	 */
	const { app, t } = useAssistant();
	const LIMIT = 280;
	let memories = $state<Memory[]>([]);
	let loaded = $state(false);
	let quick = $state('');
	let busy = $state(false);
	let editing = $state<Memory | null>(null);
	let draft = $state('');

	async function load() {
		try {
			memories = await loadMemories();
		} catch {
			app.toast(t('error'));
		} finally {
			loaded = true;
		}
	}
	$effect(() => {
		void load();
	});

	// False when it failed, so the composer gives the typing back.
	async function add(text: string): Promise<boolean> {
		const note = text.trim();
		if (!note || busy) return false;
		if (note.length > LIMIT) {
			app.toast(t('memory_too_long', { count: LIMIT }));
			return false;
		}
		busy = true;
		try {
			await addMemory(note);
			await load();
			return true;
		} catch {
			app.toast(t('error'));
			return false;
		} finally {
			busy = false;
		}
	}

	function startEdit(memory: Memory) {
		editing = memory;
		draft = memory.text;
	}

	async function save() {
		const memory = editing;
		const note = draft.trim();
		if (!memory || !note) return;
		editing = null;
		if (note === memory.text) return;
		try {
			await updateMemory(memory.id, note);
			app.toast(t('memory_saved'));
			await load();
		} catch {
			app.toast(t('error'));
		}
	}

	async function forget(memory: Memory) {
		editing = null;
		try {
			await deleteMemory(memory.id);
			app.toast(t('memory_deleted'));
			await load();
		} catch {
			app.toast(t('error'));
		}
	}
</script>

<Page template="settings">
	<PageHeader title={t('memory_title')} subtitle={t('memory_intro')} />

	<div class="grid gap-4">
		<Composer
			bind:value={quick}
			label={t('memory_add_label')}
			placeholder={t('memory_placeholder')}
			disabled={busy}
			limit={LIMIT}
			tooLong={() => t('memory_too_long', { count: LIMIT })}
			onsubmit={add}
		/>

		{#if loaded && memories.length === 0}
			<p class="text-ink-soft max-w-prose px-1 text-sm">{t('memory_empty')}</p>
		{:else if memories.length > 0}
			<Card rows aria-label={t('memory_title')}>
				{#each memories as memory (memory.id)}
					<button
						type="button"
						onclick={() => startEdit(memory)}
						class="hover:bg-idle/60 flex min-h-12 w-full items-center gap-3 px-4 py-3 text-start outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--info)]"
					>
						<span class="grid min-w-0 flex-1 gap-0.5">
							<span class="text-[15px] font-semibold break-words whitespace-pre-wrap"
								>{memory.text}</span
							>
							{#if memory.source === 'assistant'}
								<span class="text-ink-soft text-[13px]">{t('memory_from_assistant')}</span>
							{/if}
						</span>
						<ChevronRight class="text-ink-soft size-4 shrink-0" aria-hidden="true" />
					</button>
				{/each}
			</Card>
		{/if}
	</div>

	<SidePanel
		open={editing !== null}
		title={t('memory_edit')}
		closeLabel={t('close')}
		cancelLabel={t('cancel')}
		saveLabel={t('save')}
		saveDisabled={!draft.trim()}
		onsave={save}
		onclose={() => (editing = null)}
		dirty={editing !== null && draft.trim() !== editing.text}
		discard={{
			title: t('discard_title'),
			description: t('discard_hint'),
			keep: t('discard_keep'),
			discard: t('discard_confirm'),
		}}
	>
		{#snippet danger()}
			{#if editing}
				{@const memory = editing}
				<ConfirmButton
					label={t('memory_delete')}
					confirmLabel={t('memory_delete_confirm')}
					onconfirm={() => forget(memory)}
				/>
			{/if}
		{/snippet}
		<div class="grid gap-2">
			<label for="memory-edit" class="sr-only">{t('memory_edit')}</label>
			<textarea
				id="memory-edit"
				bind:value={draft}
				maxlength={LIMIT}
				rows="4"
				class="bg-idle min-h-24 w-full resize-none rounded-[var(--r-ctl)] px-3 py-2.5 text-base"
			></textarea>
			<span class="text-ink-soft text-[13px]"
				>{t('memory_chars_left', { count: LIMIT - draft.length })}</span
			>
		</div>
	</SidePanel>
</Page>
