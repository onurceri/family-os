<script lang="ts">
	import type { FileTarget } from '@famos/ext-inbox/contract';
	import { House, Refrigerator, Zap } from '@lucide/svelte';
	import {
		HOME_KIND,
		type Home,
		ITEM_KIND,
		type Item,
		SERVICE_KIND,
		type Service,
	} from '../contract/index.js';
	import { loadHomes, loadItems, loadServices } from './data.js';
	import { useHome } from './i18n.js';

	/**
	 * The homes, their things and their services as choices for "Add to…" in the Inbox
	 * (`inbox.fileTarget`): a receipt, a warranty card or a bill filed this way is never read by
	 * the AI. Shows nothing while there is nothing to file into.
	 */
	let {
		selected,
		onselect,
	}: { selected: FileTarget | null; onselect(target: FileTarget | null): void } = $props();

	const { app, t } = useHome();
	let homes = $state<Home[]>([]);
	let items = $state<Item[]>([]);
	let services = $state<Service[]>([]);
	$effect(() => {
		let live = true;
		void Promise.all([loadHomes(), loadItems(), loadServices()])
			.then(([h, i, s]) => {
				if (!live) return;
				homes = h;
				items = i;
				services = s;
			})
			.catch(() => {
				if (live) homes = items = services = [];
			});
		return () => {
			live = false;
		};
	});
	const allowed = $derived(app.can('home.view') && app.can('records.edit'));
	const choices = $derived([
		...homes.map((h) => ({ recordId: h.id, recordKind: HOME_KIND, name: h.name, icon: House })),
		...items.map((i) => ({
			recordId: i.id,
			recordKind: ITEM_KIND,
			name: i.name,
			icon: Refrigerator,
		})),
		...services.map((s) => ({
			recordId: s.id,
			recordKind: SERVICE_KIND,
			name: s.provider,
			icon: Zap,
		})),
	]);
</script>

{#if allowed && choices.length > 0}
	<div class="grid gap-2" role="group" aria-label={t('file_target_title')}>
		<p class="text-ink-soft text-xs font-semibold tracking-widest uppercase">
			{t('file_target_title')}
		</p>
		<ul class="flex flex-wrap gap-2">
			{#each choices as c (c.recordId)}
				{@const on = selected?.recordId === c.recordId}
				<li>
					<button
						type="button"
						aria-pressed={on}
						onclick={() =>
							onselect(
								on ? null : { recordId: c.recordId, recordKind: c.recordKind, name: c.name },
							)}
						class="flex min-h-11 items-center gap-2 rounded-full px-3.5 text-sm font-bold transition-colors {on
							? 'bg-surface text-ink shadow-lit ring-2'
							: 'bg-idle text-ink-soft'}"
					>
						<c.icon class="size-4" aria-hidden="true" />{c.name}
					</button>
				</li>
			{/each}
		</ul>
	</div>
{/if}
