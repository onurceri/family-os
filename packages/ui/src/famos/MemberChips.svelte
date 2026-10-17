<script lang="ts">
	import type { PresenterMember } from '../slots.js';
	import Avatar from './Avatar.svelte';

	/**
	 * Pick family members as avatar chips. `multiple` toggles any number; otherwise one member.
	 * `noneLabel` makes picking nobody a choice of its own, a first chip that is pressed while
	 * nobody is picked: "Anyone" for one member, "Whole family" for any number, where picking it
	 * clears the people and picking a person releases it.
	 */
	let {
		members,
		selected = $bindable(),
		multiple = false,
		noneLabel,
	}: {
		members: readonly PresenterMember[];
		selected: string[];
		multiple?: boolean;
		noneLabel?: string;
	} = $props();

	function toggle(id: string) {
		if (multiple) {
			selected = selected.includes(id) ? selected.filter((m) => m !== id) : [...selected, id];
		} else {
			selected = selected[0] === id && noneLabel ? [] : [id];
		}
	}

	const chip = (on: boolean) =>
		`flex min-h-11 items-center gap-2 rounded-full py-1 pr-3.5 pl-1 text-sm font-bold transition-colors ${on ? 'bg-surface text-ink shadow-lit ring-2' : 'bg-idle text-ink-soft'}`;
</script>

<div class="flex flex-wrap gap-2">
	{#if noneLabel}
		<button
			type="button"
			aria-pressed={selected.length === 0}
			onclick={() => (selected = [])}
			class="{chip(selected.length === 0)} pl-3.5 ring-[var(--ink-soft)]"
		>
			{noneLabel}
		</button>
	{/if}
	{#each members as member (member.id)}
		{@const on = selected.includes(member.id)}
		<button
			type="button"
			aria-pressed={on}
			onclick={() => toggle(member.id)}
			class={chip(on)}
			style:--tw-ring-color={member.color}
		>
			<Avatar name={member.displayName} color={member.color} size={30} />
			{member.displayName}
		</button>
	{/each}
</div>
