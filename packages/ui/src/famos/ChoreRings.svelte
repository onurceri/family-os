<script lang="ts" module>
	/** One ring: a person's chores today, or anyone's (`chores.todayByMember`). */
	export interface ChoreRing {
		/** A member id, or `anyone`. */
		id: string;
		name: string;
		/** What shows under the ring: the first name (`withShortNames`); `name` stays the title. */
		short?: string;
		/** The member's colour; none for anyone (the arc is `ink-soft`). */
		color?: string;
		done: number;
		total: number;
	}
</script>

<script lang="ts">
	import Ring from './Ring.svelte';

	/**
	 * Chores as rings: one per person with chores today, the count as text in the
	 * middle and the name under it; a ring with nothing to do recedes. `name` gives each ring its
	 * accessible name ("Elif: 1 of 3 chores done").
	 */
	let {
		rings,
		label,
		name,
		size = 48,
	}: {
		rings: readonly ChoreRing[];
		/** Accessible name of the group ("Chores"). */
		label: string;
		name?: (ring: ChoreRing) => string;
		size?: number;
	} = $props();
</script>

<ul class="rings" aria-label={label} data-testid="chore-rings">
	{#each rings as r (r.id)}
		<li>
			<Ring
				done={r.done}
				total={r.total}
				color={r.color}
				{size}
				dim={r.total === 0}
				name={name?.(r)}
			/>
			<small title={r.name}>{r.short ?? r.name}</small>
		</li>
	{/each}
</ul>

<style>
	.rings {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(52px, 1fr));
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		display: grid;
		justify-items: center;
		gap: 6px;
		min-width: 0;
	}
	small {
		max-width: 100%;
		overflow: hidden;
		font-size: 0.625rem;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-overflow: ellipsis;
		text-transform: uppercase;
		white-space: nowrap;
		color: var(--ink-soft);
	}
</style>
