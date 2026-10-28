<script lang="ts">
	import { Avatar, type ChoreRing, colorVars } from '@famos/ui/famos';

	/**
	 * Lanes' chores today: a bar per person in their colour (anyone in `ink-soft`, with the people icon), the count in
	 * the display face at the end. Each row carries its value as text for screen readers ("Amy: 2
	 * of 2 done"); the colour is never the only signal (the name is beside it).
	 */
	let {
		rings,
		label,
		name,
	}: {
		rings: readonly ChoreRing[];
		/** The list's accessible name. */
		label: string;
		/** A row's accessible name. */
		name: (ring: ChoreRing) => string;
	} = $props();
</script>

<ul class="bars" aria-label={label} data-testid="chore-bars">
	{#each rings as r (r.id)}
		<li role="img" aria-label={name(r)} style={colorVars('m', r.color || 'var(--ink-soft)')}>
			<Avatar
				name={r.name}
				color={r.color || 'var(--ink-soft)'}
				size={24}
				anyone={r.id === 'anyone'}
			/>
			<span class="n" title={r.name}>{r.short ?? r.name}</span>
			<span class="trk"
				><i style:width="{r.total > 0 ? Math.min(1, r.done / r.total) * 100 : 0}%"></i></span
			>
			<span class="f font-display">{r.done}/{r.total}</span>
		</li>
	{/each}
</ul>

<style>
	.bars {
		display: grid;
		gap: 7px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		display: grid;
		grid-template-columns: 24px minmax(3rem, 5.5rem) minmax(0, 1fr) auto;
		align-items: center;
		gap: 10px;
		min-height: 28px;
		font-size: 13px;
		color: var(--ink);
	}
	.n {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.trk {
		height: 8px;
		overflow: hidden;
		border-radius: 999px;
		background: var(--line);
	}
	.trk i {
		display: block;
		height: 100%;
		border-radius: 999px;
		background: var(--m);
	}
	.f {
		min-width: 30px;
		font-size: 16px;
		font-weight: 800;
		font-stretch: 72%;
		font-variant-numeric: tabular-nums;
		text-align: end;
	}
</style>
