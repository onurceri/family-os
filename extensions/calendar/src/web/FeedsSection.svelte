<script lang="ts">
	import { Button } from '@famos/ui/button';
	import {
		Card,
		ConfirmButton,
		Notice,
		Row,
		Section,
		Segmented,
		SidePanel,
		SwitchRow,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { Copy, Plus } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import type { Feed } from '../contract/index.js';
	import { createFeed, loadFeeds, revokeFeed } from './data.js';
	import { useCalendar } from './i18n.js';

	/**
	 * "Calendar on my phone": secret ICS addresses out. The address is shown once, right
	 * after it is made; making one happens in a panel.
	 */
	const { app, t } = useCalendar();

	let feeds = $state<Feed[]>([]);
	let loaded = $state(false);
	let adding = $state(false);
	let scope = $state<'me' | 'family'>('me');
	let includeNotes = $state(false);
	let label = $state('');
	let busy = $state(false);
	let failed = $state(false);
	let formEl = $state<HTMLFormElement>();
	/** The address of the feed just created: shown once, then gone. */
	let fresh = $state<{ id: string; url: string; webcal: string } | null>(null);

	const mayShareFamily = $derived(app.can('calendar.manage'));
	/** An address works anywhere for months, so a PIN sign-in cannot make one. */
	const mayCreate = $derived(app.fullSignIn());

	async function load() {
		try {
			feeds = await loadFeeds();
		} catch {
			feeds = [];
		}
		loaded = true;
	}
	onMount(() => void load());

	function startAdd() {
		scope = 'me';
		includeNotes = false;
		label = '';
		failed = false;
		adding = true;
	}

	async function create(event: SubmitEvent) {
		event.preventDefault();
		const me = app.me();
		if (!me) return;
		busy = true;
		failed = false;
		try {
			const result = await createFeed({
				scope: scope === 'family' ? 'family' : me.id,
				includeNotes,
				...(label.trim() && { label: label.trim() }),
			});
			const url = new URL(result.path, location.origin);
			fresh = {
				id: result.feed.id,
				url: url.toString(),
				webcal: url.toString().replace(/^https?:/, 'webcal:'),
			};
			adding = false;
			await load();
		} catch {
			failed = true;
		} finally {
			busy = false;
		}
	}

	async function copy() {
		if (!fresh) return;
		try {
			await navigator.clipboard.writeText(fresh.url);
			app.toast(t('feed_copied'));
		} catch {
			// No clipboard access: the address stays selectable in the field.
		}
	}

	async function revoke(feed: Feed) {
		try {
			await revokeFeed(feed.id);
			// A revoked address no longer works: it must not stay on screen to be copied.
			if (fresh?.id === feed.id) fresh = null;
			app.toast(t('feed_revoked'));
			await load();
		} catch {
			app.toast(t('error'));
		}
	}

	const day = (ms: number) =>
		new Intl.DateTimeFormat(app.dateLocale(), {
			day: 'numeric',
			month: 'short',
			timeZone: app.timeZone(),
		}).format(ms);

	function titleOf(feed: Feed): string {
		const who =
			feed.scope === 'family'
				? t('feed_whole_family')
				: (app.members().find((m) => m.id === feed.scope)?.displayName ?? '');
		const name = feed.label ? `${feed.label} · ${who}` : who;
		return feed.includeNotes ? `${name} · ${t('feed_with_notes')}` : name;
	}
	const metaOf = (feed: Feed) =>
		t('feed_meta', {
			created: day(feed.createdAt),
			used: feed.lastUsedAt ? t('feed_used', { when: day(feed.lastUsedAt) }) : t('feed_never_used'),
		});
</script>

<div class="grid gap-7">
	<div class="grid gap-3">
		<p class="text-ink-soft max-w-prose px-1 text-sm">{t('feeds_intro')}</p>
		<Notice tone="warn">{t('feeds_warning')}</Notice>
		{#if !mayCreate}
			<Notice tone="info"
				><span data-testid="feeds-password-needed">{t('feeds_password_needed')}</span></Notice
			>
		{/if}
		<!-- People who come here to add a holiday or school calendar learn where that is done. -->
		<p class="text-ink-soft max-w-prose px-1 text-[13px]" data-testid="feeds-outside">
			{#if mayShareFamily}
				{t('feeds_outside_manage')}
				<a class="text-info font-semibold underline underline-offset-2" href="/settings/calendars"
					>{t('nav_calendars')}</a
				>.
			{:else}
				{t('feeds_outside_hint')}
			{/if}
		</p>
	</div>

	{#if fresh}
		<Card pad class="ring-now grid gap-3 ring-2" role="status">
			<h3 class="font-extrabold">{t('feed_created_title')}</h3>
			<p class="text-ink-soft text-sm">{t('feed_created_hint')}</p>
			<Input
				readonly
				value={fresh.url}
				aria-label={t('feed_created_title')}
				onfocus={(e) => (e.currentTarget as HTMLInputElement).select()}
				class="font-mono text-xs"
			/>
			<div class="flex flex-wrap gap-2">
				<Button type="button" variant="secondary" onclick={copy}
					><Copy class="size-4" />{t('feed_copy')}</Button
				>
				<Button type="button" variant="secondary" href={fresh.webcal}>{t('feed_open')}</Button>
				<Button type="button" variant="ghost" onclick={() => (fresh = null)}
					>{t('feed_done')}</Button
				>
			</div>
			<p class="text-ink-soft text-sm">{t('feed_howto')}</p>
		</Card>
	{/if}

	{#if loaded}
		<Section label={t('feeds_list_title')} count={feeds.length}>
			{#snippet actions()}
				{#if mayCreate}
					<Button variant="ghost" size="sm" onclick={startAdd}
						><Plus class="size-4" aria-hidden="true" />{t('feed_add')}</Button
					>
				{/if}
			{/snippet}
			{#if feeds.length > 0}
				<Card rows>
					{#each feeds as feed (feed.id)}
						<Row title={titleOf(feed)} meta={metaOf(feed)}>
							{#snippet trail()}
								<ConfirmButton
									label={t('feed_revoke')}
									confirmLabel={t('feed_revoke_confirm')}
									onconfirm={() => revoke(feed)}
								/>
							{/snippet}
						</Row>
					{/each}
				</Card>
			{:else}
				<Card variant="quiet" pad><p class="text-ink-soft text-sm">{t('feeds_none')}</p></Card>
			{/if}
		</Section>
	{/if}
</div>

<SidePanel
	open={adding}
	title={t('feed_add')}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={t('feed_create')}
	saveDisabled={busy}
	onsave={() => formEl?.requestSubmit()}
	onclose={() => (adding = false)}
>
	<form class="grid gap-5" bind:this={formEl} onsubmit={create}>
		{#if mayShareFamily}
			<div class="grid gap-2">
				<span class="text-sm font-semibold">{t('feed_scope')}</span>
				<Segmented
					grow
					label={t('feed_scope')}
					options={[
						{ value: 'me', label: t('feed_scope_me') },
						{ value: 'family', label: t('feed_scope_family') },
					]}
					value={scope}
					onchange={(v) => (scope = v as 'me' | 'family')}
				/>
			</div>
		{/if}
		<Card rows>
			<SwitchRow
				id="feed-notes"
				label={t('feed_notes')}
				hint={t('feed_notes_hint')}
				bind:checked={includeNotes}
			/>
		</Card>
		<div class="grid gap-1.5">
			<Label for="feed-label">{t('feed_label')}</Label>
			<Input
				id="feed-label"
				bind:value={label}
				maxlength={60}
				placeholder={t('feed_label_placeholder')}
			/>
		</div>
		{#if failed}<p class="text-attention text-sm font-semibold" role="alert">{t('error')}</p>{/if}
	</form>
</SidePanel>
