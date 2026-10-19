<script lang="ts" module>
	export type RepeatScopeChoice = 'this' | 'following';
	export interface RepeatScopeWords {
		title: string;
		/** "Only this one" and what it does. */
		only: { label: string; hint: string };
		/** "This one and the ones after" and what it does. */
		following: { label: string; hint: string };
		cancel: string;
	}
</script>

<script lang="ts">
	import { Button } from '../components/button/index.js';
	import Dialog from './Dialog.svelte';

	/**
	 * The question a saved repeating item asks when its date or weekly days changed: change only
	 * this one, or this one and the ones after. Each choice says in a line what it will do.
	 */
	let {
		open,
		words,
		onpick,
		onclose,
	}: {
		open: boolean;
		words: RepeatScopeWords;
		onpick: (choice: RepeatScopeChoice) => void;
		onclose: () => void;
	} = $props();
</script>

<Dialog {open} title={words.title} {onclose}>
	<div class="grid gap-3">
		{#each [{ choice: 'this', ...words.only }, { choice: 'following', ...words.following }] as const as option (option.choice)}
			<div class="grid gap-1">
				<Button
					variant="secondary"
					data-autofocus={option.choice === 'this' ? true : undefined}
					data-testid="repeat-scope-{option.choice}"
					onclick={() => onpick(option.choice)}>{option.label}</Button
				>
				<p class="text-ink-soft text-[13px]">{option.hint}</p>
			</div>
		{/each}
	</div>
	{#snippet actions()}
		<Button variant="ghost" onclick={onclose}>{words.cancel}</Button>
	{/snippet}
</Dialog>
