<script lang="ts">
	import { Page, Section, SidePanel } from '@famos/ui/famos';
	import type { InboxItem } from '../contract/index.js';
	import CaptureBox from './CaptureBox.svelte';
	import CaptureDetail from './CaptureDetail.svelte';
	import CaptureGroup from './CaptureGroup.svelte';
	import DraftView from './DraftView.svelte';
	import { CaptureFeed } from './feed.svelte.js';
	import { useInbox } from './i18n.js';
	import { captureLine } from './item-view.js';
	import RecentList from './RecentList.svelte';
	import WaysIn from './WaysIn.svelte';

	/**
	 * Quick add: give it something, check what it found, add it. One column: the capture card
	 * (the hero), the other ways in, then what waits for this person (one group per capture, plus
	 * requests that are not captures) and a short history, each only when it has something.
	 * Not a mailbox: nothing here is shared with the family.
	 */
	const { app, t } = useInbox();
	const feed = new CaptureFeed(app);
	$effect(() => feed.start());

	const waiting = $derived(feed.waiting);
	const canDecide = $derived(app.can('core.drafts.approve'));
	const recent = $derived(feed.recent);
	const selectedId = $derived(app.query().get('capture'));
	const selected = $derived(selectedId ? feed.capture(selectedId) : undefined);

	const sent = (item: InboxItem) => feed.add(item);
	const open = (id: string) => app.setQuery({ capture: id });
	const close = () => app.setQuery({ capture: null }, { replace: true });
</script>

<Page template="capture" title={t('title')} subtitle={t('lead')}>
	<div class="grid content-start gap-10">
		<div class="grid gap-7">
			<CaptureBox onsent={sent} hero />
			<WaysIn />
		</div>

		{#if feed.loaded}
			{#if feed.failed && waiting.length === 0}
				<p class="text-attention font-semibold" role="alert">{t('error')}</p>
			{/if}
			{#if waiting.length}
				<Section
					label={t(canDecide ? 'section_waiting' : 'section_waiting_approval')}
					count={waiting.length}
				>
					<div class="grid gap-9">
						{#each waiting as capture (capture.item.id)}
							<CaptureGroup {capture} onchanged={() => void feed.load()} />
						{/each}
					</div>
				</Section>
			{/if}
			{#if feed.requests.length}
				<div data-testid="requests">
					<Section label={t('requests')} count={feed.requests.length}>
						<p class="text-ink-soft -mt-1 text-[13px]">{t('requests_hint')}</p>
						<div
							class="grid grid-cols-[repeat(auto-fit,minmax(min(20rem,100%),1fr))] items-start gap-3"
						>
							{#each feed.requests as draft (draft.id)}<DraftView {draft} />{/each}
						</div>
					</Section>
				</div>
			{/if}
			<RecentList captures={recent} selectedId={selected?.item.id} onselect={open} />
		{/if}
	</div>
</Page>

<SidePanel
	open={Boolean(selected)}
	title={selected ? captureLine(selected.item) : ''}
	onclose={close}
	closeLabel={t('close')}
>
	{#if selected}
		{#key selected.item.id}
			<CaptureDetail capture={selected} onchanged={() => void feed.load()} onclose={close} />
		{/key}
	{/if}
</SidePanel>
