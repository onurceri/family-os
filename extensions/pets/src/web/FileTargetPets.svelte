<script lang="ts">
	import type { FileTarget } from '@famos/ext-inbox/contract';
	import { FileTargetChoices } from '@famos/ui/famos';
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
	const allowed = $derived(
		app.can('pets.view') && app.access('records.attachDocument') === 'apply',
	);
	const choices = $derived(
		allowed
			? pets.map((r) => ({ recordId: r.id, recordKind: RECORD_KIND, name: r.name, icon: PawPrint }))
			: [],
	);
</script>

<FileTargetChoices title={t('file_target_title')} {choices} {selected} {onselect} />
