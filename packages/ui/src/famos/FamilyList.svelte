<script lang="ts" module>
	/** One person and their status clause (`statusOf` → `statusText`). */
	export interface FamilyStatus {
		id: string;
		displayName: string;
		color: string;
		status: string;
		/** A word about them beside the name ("Home"), from an extension; never coloured. */
		note?: string;
		/** Things for no one in particular: a people icon, not a letter. */
		anyone?: boolean;
	}
</script>

<script lang="ts">
	import { colorVars } from '../colors.js';
	import Avatar from './Avatar.svelte';

	/**
	 * The family with one honest status each: a ringed avatar, the name (and a note beside it,
	 * "Home") and a one-line clause cut with an ellipsis, never wrapped. `list` stacks rows (the
	 * wall); `strip` sets them side by side, centred (phones), with the note under the name instead
	 * of the clause.
	 */
	let {
		people,
		label,
		variant = 'list',
	}: {
		people: readonly FamilyStatus[];
		/** Accessible name of the list ("Family"). */
		label: string;
		variant?: 'list' | 'strip';
	} = $props();
</script>

<ul class="family {variant}" aria-label={label} data-testid="family-list">
	{#each people as p (p.id)}
		<li style={colorVars('member', p.color)}>
			<span class="ringed"
				><Avatar name={p.displayName} color={p.color} size={32} anyone={p.anyone} /></span
			>
			<span class="t">
				{#if variant === 'strip'}
					<b>{p.displayName}</b>
					{#if p.note}<small class="note" title={p.note}>{p.note}</small>{/if}
				{:else}
					<span class="nm"
						><b>{p.displayName}</b>{#if p.note}<span class="note" title={p.note}>{p.note}</span
							>{/if}</span
					>
					<small title={p.status}>{p.status}</small>
				{/if}
			</span>
		</li>
	{/each}
</ul>

<style>
	.family {
		display: grid;
		gap: 10px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		display: flex;
		align-items: center;
		gap: 14px;
		min-width: 0;
		min-height: 40px;
	}
	.ringed {
		display: inline-flex;
		flex: none;
		margin-inline-start: 4px;
		border-radius: 999px;
		box-shadow:
			0 0 0 2px var(--wall),
			0 0 0 4px var(--member);
	}
	.t {
		display: grid;
		min-width: 0;
		line-height: 1.2;
	}
	b {
		overflow: hidden;
		font-size: 15px;
		font-weight: 700;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.nm {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
	}
	/* The name gives way before the note: "Home" stays whole. */
	.nm b {
		min-width: 0;
	}
	.nm .note {
		flex: none;
		max-width: 60%;
		overflow: hidden;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink-soft);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	small {
		overflow: hidden;
		font-size: 13px;
		color: var(--ink-soft);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.strip {
		grid-auto-columns: minmax(0, 1fr);
		grid-auto-flow: column;
		gap: 8px;
	}
	.strip li {
		display: grid;
		justify-items: center;
		gap: 6px;
		text-align: center;
	}
	.strip .ringed {
		margin: 4px 0 0;
	}
	.strip .t {
		justify-items: center;
		max-width: 100%;
	}
	.strip b {
		font-size: 12px;
	}
	.strip small {
		max-width: 100%;
		font-size: 11px;
	}
</style>
