<script lang="ts">
	import type { FileTarget } from '@famos/ext-inbox/contract';
	import { FileTargetChoices } from '@famos/ui/famos';
	import { Car } from '@lucide/svelte';
	import { type Vehicle, RECORD_KIND } from '../contract/index.js';
	import { loadVehicles } from './data.js';
	import { useVehicles } from './i18n.js';

	/**
	 * The vehicles as choices for "Add to…" in the Inbox (`inbox.fileTarget`): papers filed to a
	 * vehicle are never read by the AI. Shows nothing while there are no vehicles.
	 */
	let {
		selected,
		onselect,
	}: { selected: FileTarget | null; onselect(target: FileTarget | null): void } = $props();

	const { app, t } = useVehicles();
	let vehicles = $state<Vehicle[]>([]);
	$effect(() => {
		let live = true;
		void loadVehicles()
			.then((list) => live && (vehicles = list))
			.catch(() => live && (vehicles = []));
		return () => {
			live = false;
		};
	});
	const allowed = $derived(
		app.can('vehicles.view') && app.access('records.attachDocument') === 'apply',
	);
	const choices = $derived(
		allowed
			? vehicles.map((r) => ({ recordId: r.id, recordKind: RECORD_KIND, name: r.name, icon: Car }))
			: [],
	);
</script>

<FileTargetChoices title={t('file_target_title')} {choices} {selected} {onselect} />
