<script lang="ts">
	import { page } from '$app/state';
	import { Page as PageFrame, trackWork } from '@famos/ui/famos';
	import type { PageContribution, PageProps } from '@famos/ui/slots';
	import type { Component } from 'svelte';
	import { ownerOf, pageFor } from '#lib/extensions.js';
	import PageGate from '#lib/PageGate.svelte';
	import { t } from '#lib/i18n.svelte.js';
	import { session } from '#lib/session.svelte.js';

	// Extension pages: matched by path (`/vehicles/:id` patterns too), loaded lazily.
	// The path alone (a string), so a change of the query (`?thread=`) does not remount the page.
	const pathname = $derived(page.url.pathname);
	const found = $derived(pageFor(pathname));
	// A turned-off extension's pages are gone until it is turned on again.
	const contribution = $derived(
		found && !session.disabledExtensions.includes(ownerOf(found.page.id)) ? found : undefined,
	);

	// The component of the matched page, loaded once and kept; the page and its params change
	// together so a page never sees the params of another one.
	const loaded = new Map<PageContribution, Component<PageProps>>();
	let shown = $state.raw<{ Page: Component<PageProps>; params: Record<string, string> }>();
	$effect(() => {
		const target = contribution;
		if (!target) {
			shown = undefined;
			return;
		}
		const { page: entry, params } = target;
		const ready = loaded.get(entry);
		if (ready) {
			shown = { Page: ready, params };
			return;
		}
		let stale = false;
		// The page's code counts as work until it has arrived (and asked for its data).
		void trackWork(entry.component()).then((mod) => {
			const Page = mod.default as Component<PageProps>;
			loaded.set(entry, Page);
			if (!stale) shown = { Page, params };
		});
		return () => {
			stale = true;
		};
	});
</script>

{#if contribution}
	{#if shown}
		<!-- Keyed by the component, not the path: moving between two records of one page keeps it
	     mounted (the list stays, only the params change); another page mounts fresh. -->
		{#key shown.Page}
			<PageGate><shown.Page params={shown.params} /></PageGate>
		{/key}
	{/if}
{:else}
	<PageGate><PageFrame template="list" title={t('not_found')} /></PageGate>
{/if}
