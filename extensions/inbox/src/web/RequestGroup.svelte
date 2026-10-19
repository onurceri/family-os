<script lang="ts">
	import { Avatar } from '@famos/ui/famos';
	import { memberBehindDraft } from '@famos/ui/slots';
	import { Plug, Sparkles, UserRound } from '@lucide/svelte';
	import DraftView from './DraftView.svelte';
	import { captureTime } from './format.js';
	import { useInbox } from './i18n.js';
	import type { RequestGroup } from './item-view.js';

	/**
	 * Suggestions that did not come from a capture, under "Waiting for you" with the captures: the
	 * ones an assistant answer or a connected app made, or what a person sent for approval. A line
	 * says where they came from and for whom; each card is decided on its own.
	 */
	let { group }: { group: RequestGroup } = $props();
	const { app, t } = useInbox();

	const first = $derived(group.drafts[0]);
	const behind = $derived(memberBehindDraft(first?.proposedBy));
	const person = $derived(
		behind && behind !== app.me()?.id ? app.members().find((m) => m.id === behind) : undefined,
	);
	const Icon = $derived(
		group.origin === 'assistant' ? Sparkles : group.origin === 'app' ? Plug : UserRound,
	);
	const line = $derived(
		t(
			group.origin === 'assistant'
				? 'request_from_assistant'
				: group.origin === 'app'
					? 'request_from_app'
					: 'request_from_person',
		),
	);
</script>

<article class="grid gap-3" aria-label={line} data-testid="request-group">
	<header class="flex items-start gap-3">
		<span class="text-ink-soft bg-idle grid size-9 shrink-0 place-items-center rounded-full">
			<Icon class="size-4" aria-hidden="true" />
		</span>
		<div class="grid min-w-0 flex-1 gap-0.5">
			<h3 class="text-[17px] leading-snug font-bold text-balance">{line}</h3>
			<p class="text-ink-soft flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
				<span>{captureTime(app, group.latest)}</span>
				{#if person}
					<span class="flex items-center gap-1.5 font-semibold">
						<Avatar name={person.displayName} color={person.color} size={18} />
						{t('from', { name: person.displayName })}
					</span>
				{/if}
			</p>
		</div>
	</header>
	<div
		class="grid grid-cols-[repeat(auto-fit,minmax(min(18rem,100%),1fr))] items-start gap-3"
		data-testid="suggestions"
	>
		{#each group.drafts as draft (draft.id)}<DraftView {draft} byline={false} />{/each}
	</div>
</article>
