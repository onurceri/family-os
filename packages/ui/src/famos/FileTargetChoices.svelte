<script lang="ts">
	import type { Component } from 'svelte';

	/**
	 * The records a person can pick to file Quick add papers into ("Add to…"), as pill buttons
	 * under a small title. Shows nothing while there is nothing to choose; the extension decides
	 * whether the person may file at all.
	 */
	let {
		title,
		choices,
		selected,
		onselect,
	}: {
		title: string;
		choices: readonly {
			recordId: string;
			recordKind: string;
			/** What the person sees ("Golf", "Luna"). */
			name: string;
			icon: Component<{ class?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
		}[];
		selected: { recordId: string } | null;
		onselect(target: { recordId: string; recordKind: string; name: string } | null): void;
	} = $props();
</script>

{#if choices.length > 0}
	<div class="grid gap-2" role="group" aria-label={title}>
		<p class="text-ink-soft text-xs font-semibold tracking-widest uppercase">{title}</p>
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
