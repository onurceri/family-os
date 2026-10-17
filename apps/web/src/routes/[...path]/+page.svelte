<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '@famos/ui/button';
	import { EmptyState, Page as PageFrame, trackWork } from '@famos/ui/famos';
	import type { PageContribution, PageProps } from '@famos/ui/slots';
	import type { Component } from 'svelte';
	import { contributions, ownerOf, pageFor } from '#lib/extensions.js';
	import PageGate from '#lib/PageGate.svelte';
	import { getLocale, t, tDynamic } from '#lib/i18n.svelte.js';
	import { session } from '#lib/session.svelte.js';
	import { api } from '#lib/api.js';
	import { notInstalledOwner } from '#lib/not-installed.js';
	import { nameOf, type Entry } from '../settings/extensions/entries.js';

	// Extension pages: matched by path (`/vehicles/:id` patterns too), loaded lazily.
	// The path alone (a string), so a change of the query (`?thread=`) does not remount the page.
	const pathname = $derived(page.url.pathname);
	const found = $derived(pageFor(pathname));
	// A turned-off extension's pages are gone until it is turned on again.
	const owner = $derived(found ? ownerOf(found.page.id) : undefined);
	const switchedOff = $derived(owner !== undefined && session.disabledExtensions.includes(owner));
	const contribution = $derived(found && !switchedOff ? found : undefined);
	// The page of a switched-off extension says so, with its name, instead of "does not exist".
	const offName = $derived.by(() => {
		if (!switchedOff || !owner) return '';
		const labelKey = contributions.extension(owner)?.labelKey;
		return labelKey ? tDynamic(labelKey) : owner;
	});
	// Whoever may switch it on (and open the page where that is done) gets the way there.
	const mayManage = $derived(session.can('core.extensions.manage'));
	const maySwitch = $derived(
		session.can('core.features.manage') && session.can('core.extensions.manage'),
	);

	// A path that matches no page: an extension that is not installed, or a page that never
	// existed. Whoever manages extensions can tell which, by the list of what the server has.
	let known = $state.raw<Entry[]>([]);
	$effect(() => {
		if (found || switchedOff || !mayManage) {
			known = [];
			return;
		}
		let stale = false;
		void api.GET('/api/v1/core/extensions').then((result) => {
			if (!stale) known = result.data?.extensions ?? [];
		});
		return () => {
			stale = true;
		};
	});
	const missing = $derived(notInstalledOwner(pathname, known));
	const missingName = $derived(
		missing ? nameOf(missing, { language: getLocale(), loaded: undefined }) : '',
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
{:else if switchedOff}
	<PageGate>
		<PageFrame template="list">
			<EmptyState
				title={t('feature_off_title', { name: offName })}
				hint={maySwitch ? t('feature_off_hint_manage') : t('feature_off_hint')}
			>
				{#if maySwitch}
					<Button variant="primary" href="/settings/extensions">{t('feature_off_open')}</Button>
				{/if}
			</EmptyState>
		</PageFrame>
	</PageGate>
{:else}
	<PageGate>
		<PageFrame template="list">
			<EmptyState
				title={missing ? t('not_installed_title', { name: missingName }) : t('not_found')}
				hint={missing ? t('not_installed_hint_manage') : t('not_found_hint')}
			>
				{#if missing}
					<Button
						variant="primary"
						href="/settings/extensions?open={encodeURIComponent(missing.id)}"
						>{t('not_installed_open')}</Button
					>
				{:else}
					<Button variant="primary" href="/">{t('not_found_back')}</Button>
				{/if}
			</EmptyState>
		</PageFrame>
	</PageGate>
{/if}
