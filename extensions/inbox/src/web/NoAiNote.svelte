<script lang="ts">
	import { Sparkles } from '@lucide/svelte';
	import { loadAiReading } from './data.js';
	import { useInbox } from './i18n.js';

	/**
	 * Said under the capture box before anything is typed, when no AI can read what is added:
	 * that it waits unread, a way to set up AI for whoever may, and for everyone the pages where
	 * things are added by hand. Nothing while it is not known.
	 */
	const { app, t } = useInbox();

	let reading = $state<boolean | null>(null);
	$effect(() => {
		let live = true;
		const load = () =>
			void loadAiReading().then((answer) => {
				if (live) reading = answer;
			});
		load();
		const off = app.onEvent('core.aiModels.', load);
		return () => {
			live = false;
			off();
		};
	});

	const canSetUp = $derived(app.can('core.ai.manage'));
	const places = $derived(app.addPlaces());
</script>

{#if reading === false}
	<div
		class="text-ink-soft flex items-start gap-3 text-[13px] leading-snug"
		role="note"
		data-testid="quick-add-no-ai"
	>
		<span class="bg-idle grid size-9 shrink-0 place-items-center rounded-full">
			<Sparkles class="size-[18px]" aria-hidden="true" />
		</span>
		<div class="grid min-w-0 gap-1.5">
			<p class="text-pretty">
				{t('no_ai_line')}
				{#if !canSetUp}{t('no_ai_ask')}{/if}
			</p>
			{#if canSetUp}
				<a
					href="/settings/ai"
					class="text-ink justify-self-start font-semibold underline underline-offset-4"
					>{t('no_ai_set_up')}</a
				>
			{/if}
			{#if places.length}
				<p class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
					<span>{t('no_ai_by_hand')}</span>
					{#each places as place (place.path)}
						<a href={place.path} class="text-ink font-semibold underline underline-offset-4"
							>{app.t(place.labelKey)}</a
						>
					{/each}
				</p>
			{/if}
		</div>
	</div>
{/if}
