<script lang="ts">
	import { Button } from '@famos/ui/button';
	import { FolderInput, Sparkles } from '@lucide/svelte';
	import { type InboxItem, READ_ATTEMPTS } from '../contract/index.js';
	import { retryItem } from './data.js';
	import { useInbox } from './i18n.js';
	import { askAssistantHref, isQuestionForAssistant } from './item-view.js';

	/** Failures an admin fixes in AI settings. */
	const AI_SETTINGS_ERRORS: ReadonlySet<string> = new Set([
		'not_configured',
		'data_policy',
		'ai_local_required',
		'files_off',
		'voice_not_read',
	]);

	/**
	 * How reading a capture went, in place: still reading, could not be read (Try again), kept
	 * unread because AI is off (Read now), filed by hand, or read with nothing to add or a
	 * question for the assistant. Suggestions are shown by the caller.
	 */
	let { item, showFound = false }: { item: InboxItem; showFound?: boolean } = $props();
	const { app, t } = useInbox();

	const reading = $derived(item.status === 'received' || item.status === 'normalized');
	const canSetUpAi = $derived(app.can('core.ai.manage'));
	const isQuestion = $derived(isQuestionForAssistant(item));

	async function retry() {
		try {
			await retryItem(item.id);
		} catch {
			app.toast(t('error'));
		}
	}
</script>

{#snippet skippedLines()}
	{#if item.skippedUnknown}<small class="text-ink-soft block text-xs"
			>{t('status_skipped_unknown', { count: item.skippedUnknown })}</small
		>{/if}
	{#if item.skipped > item.skippedUnknown}<small class="text-ink-soft block text-xs"
			>{t('status_skipped', { count: item.skipped - item.skippedUnknown })}</small
		>{/if}
{/snippet}

<div class="flex flex-wrap items-center gap-2 text-sm">
	{#if reading}
		<span class="grid w-full gap-2" data-testid="capture-reading">
			<span class="text-ink-soft font-semibold" role="status"
				>{item.attempt
					? t('status_retrying', { attempt: item.attempt, max: READ_ATTEMPTS })
					: t('status_reading')}</span
			>
			<!-- A calm line that moves while the AI reads; still with reduced motion. -->
			<span class="bg-line relative block h-1.5 w-full overflow-hidden rounded-full">
				<span class="bar absolute inset-y-0 left-0 w-2/5 rounded-full"></span>
			</span>
		</span>
	{:else if item.status === 'failed'}
		<span class="text-attention grid gap-0.5 font-semibold" role="alert">
			{t(`error_${item.errorCode ?? 'unavailable'}`)}
			{#if canSetUpAi && item.errorCode && AI_SETTINGS_ERRORS.has(item.errorCode)}
				<a
					href="/settings/ai"
					class="text-ink-soft text-xs font-medium underline underline-offset-4"
					>{item.errorCode === 'not_configured'
						? t('error_not_configured_admin')
						: t('open_ai_settings')}</a
				>
			{/if}
		</span>
		<Button variant="outline" class="ml-auto" onclick={retry}>{t('retry')}</Button>
	{:else if item.status === 'filed'}
		<FolderInput class="text-info size-4 shrink-0" aria-hidden="true" />
		<span class="min-w-0 flex-1 font-semibold" role="status"
			>{item.filedTo?.recordName
				? t('status_filed_to', { name: item.filedTo.recordName })
				: t('status_filed')}</span
		>
	{:else if item.status === 'held'}
		<span class="text-ink-soft font-semibold" role="status">{t('status_held')}</span>
		<Button variant="outline" class="ml-auto" onclick={retry}>{t('read_now')}</Button>
	{:else if showFound || !item.proposals}
		<Sparkles class="text-info size-4 shrink-0" aria-hidden="true" />
		<span class="min-w-0 flex-1 {isQuestion ? 'basis-56' : ''}">
			<span class="text-ink-soft"
				>{item.proposals
					? t('status_found', { count: item.proposals })
					: isQuestion
						? t('status_question')
						: t('status_nothing')}</span
			>
			{@render skippedLines()}
		</span>
		{#if isQuestion}
			<Button href={askAssistantHref(item)} class="ml-auto" data-testid="ask-assistant"
				>{t('ask_assistant')}</Button
			>
		{/if}
	{:else if item.skipped > 0}
		<span class="min-w-0 flex-1">{@render skippedLines()}</span>
	{/if}
</div>

<style>
	.bar {
		background: linear-gradient(
			90deg,
			transparent,
			color-mix(in srgb, var(--info) 60%, transparent),
			transparent
		);
		animation: read-line 1.8s ease-in-out infinite;
	}
	@keyframes read-line {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(250%);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.bar {
			animation: none;
			width: 100%;
			background: color-mix(in srgb, var(--info) 30%, transparent);
		}
	}
</style>
