<script lang="ts">
	import type { FileTarget } from '@famos/ext-inbox/contract';
	import { PawPrint } from '@lucide/svelte';
	import { type Pet, RECORD_KIND } from '../contract/index.js';
	import { loadPets } from './data.js';
	import { usePets } from './i18n.js';

	/**
	 * The pets as choices for "Add to…" in the Inbox (`inbox.fileTarget`): papers filed to a pet
	 * are never read by the AI. Shows nothing while there are no pets.
	 */
	let {
		selected,
		onselect,
	}: { selected: FileTarget | null; onselect(target: FileTarget | null): void } = $props();

	const { app, t } = usePets();
	let pets = $state<Pet[]>([]);
	$effect(() => {
		let live = true;
		void loadPets()
			.then((list) => live && (pets = list))
			.catch(() => live && (pets = []));
		return () => {
			live = false;
		};
	});
	const allowed = $derived(app.can('pets.view') && app.can('records.edit'));
	const target = (p: Pet): FileTarget => ({
		recordId: p.id,
		recordKind: RECORD_KIND,
		name: p.name,
	});
</script>

{#if allowed && pets.length > 0}
	<div class="grid gap-2" role="group" aria-label={t('file_target_title')}>
		<p class="text-ink-soft text-xs font-semibold tracking-widest uppercase">
			{t('file_target_title')}
		</p>
		<ul class="flex flex-wrap gap-2">
			{#each pets as p (p.id)}
				{@const on = selected?.recordId === p.id}
				<li>
					<button
						type="button"
						aria-pressed={on}
						onclick={() => onselect(on ? null : target(p))}
						class="flex min-h-11 items-center gap-2 rounded-full px-3.5 text-sm font-bold transition-colors {on
							? 'bg-surface text-ink shadow-lit ring-2'
							: 'bg-idle text-ink-soft'}"
					>
						<PawPrint class="size-4" aria-hidden="true" />{p.name}
					</button>
				</li>
			{/each}
		</ul>
	</div>
{/if}
