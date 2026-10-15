<script lang="ts">
	import { Page, Section, SidePanel } from '@famos/ui/famos';
	import type { InboxItem } from '../contract/index.js';
	import CaptureBox from './CaptureBox.svelte';
	import CaptureDetail from './CaptureDetail.svelte';
	import CaptureGroup from './CaptureGroup.svelte';
	import DraftView from './DraftView.svelte';
	import { CaptureFeed, type RecentEntry } from './feed.svelte.js';
	import { useInbox } from './i18n.js';
	import { captureLine } from './item-view.js';
	import RecentList from './RecentList.svelte';
	import { requestTitle } from './request-title.js';
	import RequestGroup from './RequestGroup.svelte';
	import WaysIn from './WaysIn.svelte';

	/**
	 * Quick add: give it something, check what it found, add it. One column: the capture card
	 * (the hero), the other ways in, then what waits for this person (one group per capture, and one
	 * for the requests from each other place: an assistant answer, a connected app, a person) and a
	 * short history (the person's captures, and their requests somebody decided lately), each only
	 * when it has something. Every suggestion waits here: the badge counts what is here, and the
	 * notifications link here.
	 * Not a mailbox: nothing here is shared with the family.
	 */
	const { app, t } = useInbox();
	const feed = new CaptureFeed(app);
	$effect(() => feed.start());

	const entries = $derived(feed.entries);
	const canDecide = $derived(app.can('core.drafts.approve'));
	const recent = $derived(feed.recentEntries);
	const selectedId = $derived(app.query().get('capture'));
	const selected = $derived(selectedId ? feed.capture(selectedId) : undefined);
	const requestId = $derived(app.query().get('request'));
	const request = $derived(requestId ? feed.decidedRequest(requestId) : undefined);

	const sent = (item: InboxItem) => feed.add(item);
	const open = (entry: RecentEntry) =>
		app.setQuery(
			entry.kind === 'capture'
				? { capture: entry.key, request: null }
				: { request: entry.key, capture: null },
		);
	const close = () => app.setQuery({ capture: null, request: null }, { replace: true });
</script>

<Page template="capture" title={t('title')} subtitle={t('lead')}>
	<div class="grid content-start gap-10">
		<div class="grid gap-7">
			<CaptureBox onsent={sent} hero />
			<WaysIn />
		</div>

		{#if feed.loaded}
			{#if feed.failed && entries.length === 0}
				<p class="text-attention font-semibold" role="alert">{t('error')}</p>
			{/if}
			{#if entries.length}
				<Section
					label={t(canDecide ? 'section_waiting' : 'section_waiting_approval')}
					count={feed.waitingSuggestions || undefined}
				>
					<div class="grid gap-9">
						{#each entries as entry (entry.key)}
							{#if entry.kind === 'capture'}
								<CaptureGroup capture={entry.capture} onchanged={() => void feed.load()} />
							{:else}
								<RequestGroup group={entry.group} />
							{/if}
						{/each}
					</div>
				</Section>
			{/if}
			<RecentList entries={recent} selectedId={selected?.item.id ?? request?.id} onselect={open} />
		{/if}
	</div>
</Page>

<SidePanel
	open={Boolean(selected) || Boolean(request)}
	title={selected ? captureLine(selected.item) : request ? requestTitle(app, request) : ''}
	onclose={close}
	closeLabel={t('close')}
>
	{#if selected}
		{#key selected.item.id}
			<CaptureDetail capture={selected} onchanged={() => void feed.load()} onclose={close} />
		{/key}
	{:else if request}
		{#key request.id}
			<DraftView draft={request} byline={false} />
		{/key}
	{/if}
</SidePanel>
