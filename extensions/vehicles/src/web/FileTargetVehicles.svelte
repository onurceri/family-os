<script lang="ts">
	import type { FileTarget } from '@famos/ext-inbox/contract';
	import { Car } from '@lucide/svelte';
	import { RECORD_KIND, type Vehicle } from '../contract/index.js';
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
	const allowed = $derived(app.can('vehicles.view') && app.can('records.edit'));
	const target = (v: Vehicle): FileTarget => ({
		recordId: v.id,
		recordKind: RECORD_KIND,
		name: v.name,
	});
</script>

{#if allowed && vehicles.length > 0}
	<div class="grid gap-2" role="group" aria-label={t('file_target_title')}>
		<p class="text-ink-soft text-xs font-semibold tracking-widest uppercase">
			{t('file_target_title')}
		</p>
		<ul class="flex flex-wrap gap-2">
			{#each vehicles as v (v.id)}
				{@const on = selected?.recordId === v.id}
				<li>
					<button
						type="button"
						aria-pressed={on}
						onclick={() => onselect(on ? null : target(v))}
						class="flex min-h-11 items-center gap-2 rounded-full px-3.5 text-sm font-bold transition-colors {on
							? 'bg-surface text-ink shadow-lit ring-2'
							: 'bg-idle text-ink-soft'}"
					>
						<Car class="size-4" aria-hidden="true" />{v.name}
					</button>
				</li>
			{/each}
		</ul>
	</div>
{/if}
