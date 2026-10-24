<script lang="ts">
	import type { paths } from '@famos/api-client';
	import { Card, Composer, ConfirmButton, Page, PageHeader, SidePanel } from '@famos/ui/famos';
	import { Textarea } from '@famos/ui/textarea';
	import { ChevronRight } from '@lucide/svelte';
	import { api } from '#lib/api.js';
	import { t } from '#lib/i18n.svelte.js';
	import { runAction } from '#lib/run-action.js';
	import { toasts } from '#lib/toast.svelte.js';

	/**
	 * Memory, Settings, You: the member's own short notes. Only they can read them; the assistant
	 * and the AI apps they connect read them in their own conversations. Add one in the field,
	 * change or forget one in a panel; notes the AI suggests arrive as suggestions to approve.
	 */
	type Memory =
		paths['/api/v1/core/memories']['get']['responses'][200]['content']['application/json'][number];

	const LIMIT = 280;
	let memories = $state<Memory[]>([]);
	let loaded = $state(false);
	let quick = $state('');
	let busy = $state(false);
	let editing = $state<Memory | null>(null);
	let draft = $state('');

	async function load() {
		const result = await runAction(api.GET('/api/v1/core/memories'));
		if (result.ok) memories = result.data;
		loaded = true;
	}
	$effect(() => {
		void load();
	});

	// False when it failed, so the composer gives the typing back.
	async function add(text: string): Promise<boolean> {
		const note = text.trim();
		if (!note || busy) return false;
		if (note.length > LIMIT) {
			toasts.show(t('memory_too_long', { count: LIMIT }));
			return false;
		}
		busy = true;
		const result = await runAction(
			api.POST('/api/v1/actions/core.addMemory', { body: { text: note } }),
			{ reload: load },
		);
		busy = false;
		return result.ok;
	}

	function startEdit(memory: Memory) {
		editing = memory;
		draft = memory.text;
	}

	async function save() {
		const memory = editing;
		const note = draft.trim();
		if (!memory || !note || note.length > LIMIT) return;
		editing = null;
		if (note === memory.text) return;
		await runAction(
			api.POST('/api/v1/actions/core.updateMemory', { body: { id: memory.id, text: note } }),
			{ saved: t('memory_saved'), reload: load },
		);
	}

	async function forget(memory: Memory) {
		editing = null;
		await runAction(api.POST('/api/v1/actions/core.deleteMemory', { body: { id: memory.id } }), {
			saved: t('memory_deleted'),
			reload: load,
		});
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
							{#if memory.source === 'ai'}
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
		closeLabel={t('side_panel_close')}
		cancelLabel={t('cancel')}
		saveLabel={t('save')}
		saveDisabled={!draft.trim() || draft.trim().length > LIMIT}
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
			<Textarea
				id="memory-edit"
				bind:value={draft}
				maxlength={LIMIT}
				rows={4}
				class="bg-idle min-h-24 w-full resize-none rounded-[var(--r-ctl)] px-3 py-2.5 text-base"
			></Textarea>
		</div>
	</SidePanel>
</Page>
