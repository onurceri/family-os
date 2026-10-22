<script lang="ts">
	import { Pill, Row, Section } from '@famos/ui/famos';
	import { Bot, Plug, Sparkles, UserRound } from '@lucide/svelte';
	import CaptureIcon from './CaptureIcon.svelte';
	import type { RecentEntry } from './feed.svelte.js';
	import { captureTime } from './format.js';
	import { useInbox } from './i18n.js';
	import { captureLine, itemChip, requestChip, requestOrigin } from './item-view.js';
	import { requestTitle } from './request-title.js';

	/**
	 * The person's last captures with how each went, and their requests somebody decided lately
	 * with the answer. A list you can open, not a place to work: opening one shows it in the side
	 * panel. Nothing at all when there is no history yet.
	 */
	let {
		entries,
		selectedId = null,
		onselect,
	}: {
		entries: readonly RecentEntry[];
		/** The open capture's or request's id. */
		selectedId?: string | null;
		onselect: (entry: RecentEntry) => void;
	} = $props();
	const { app, t } = useInbox();

	const TONE = {
		attention: 'attention',
		now: 'now',
		info: 'info',
		idle: 'default',
	} as const;
</script>

{#if entries.length}
	<Section label={t('recent')}>
		<ul class="grid gap-1.5">
			{#each entries as entry (entry.key)}
				<li>
					{#if entry.kind === 'capture'}
						{@const { item, drafts } = entry.capture}
						{@const chip = itemChip(item, drafts)}
						<Row
							tile
							data-testid="recent-row"
							selected={selectedId === item.id}
							onclick={() => onselect(entry)}
							title={captureLine(item)}
							meta={captureTime(app, item.createdAt)}
						>
							{#snippet lead()}
								<span class="bg-idle text-ink-soft grid size-9 place-items-center rounded-full">
									<CaptureIcon {item} />
								</span>
							{/snippet}
							{#snippet trail()}
								<Pill tone={TONE[chip.tone]}
									>{t(chip.key, chip.count === undefined ? undefined : { count: chip.count })}</Pill
								>
							{/snippet}
						</Row>
					{:else}
						{@const draft = entry.draft}
						{@const chip = requestChip(draft)}
						{@const origin = requestOrigin(draft)}
						{@const Icon =
							origin === 'assistant'
								? Sparkles
								: origin === 'app'
									? Plug
									: origin === 'ai_app'
										? Bot
										: UserRound}
						<Row
							tile
							data-testid="recent-request"
							selected={selectedId === draft.id}
							onclick={() => onselect(entry)}
							title={requestTitle(app, draft)}
							meta={captureTime(app, entry.at)}
						>
							{#snippet lead()}
								<span class="bg-idle text-ink-soft grid size-9 place-items-center rounded-full">
									<Icon class="size-4" aria-hidden="true" />
								</span>
							{/snippet}
							{#snippet trail()}
								<Pill tone={TONE[chip.tone]}>{t(chip.key)}</Pill>
							{/snippet}
						</Row>
					{/if}
				</li>
			{/each}
		</ul>
	</Section>
{/if}
