<script lang="ts">
	import { page } from '$app/state';
	import { dateTimeFormat } from '#lib/format.svelte.js';
	import { type paths } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import { Card, Notice, Page, PageHeader, Row, Section, SwitchRow } from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { tick } from 'svelte';
	import { api } from '#lib/api.js';
	import { isAppPath } from '#lib/extensions.js';
	import { runAction } from '#lib/run-action.js';
	import { t } from '#lib/i18n.svelte.js';
	import { push } from '#lib/push.svelte.js';
	import { session } from '#lib/session.svelte.js';
	import { groupKinds, kindAnchor, kindFromHash } from './groups.js';
	import KindRow from './KindRow.svelte';
	import TelegramLink from './TelegramLink.svelte';

	/**
	 * Notification settings: where this person is reached (this device, their other devices,
	 * Telegram, channels that say how to set them up), quiet hours, and every kind of notification
	 * in its group, one row each with a switch per channel. `#kind-<id>` scrolls to a kind and marks
	 * it for a moment.
	 */
	type Json<P extends keyof paths, M extends 'get'> = paths[P][M] extends {
		responses: { 200: { content: { 'application/json': infer R } } };
	}
		? R
		: never;
	type Preferences = Json<'/api/v1/core/notifications/preferences', 'get'>;
	type Prefs = Preferences['prefs'];
	type Kind = Preferences['kinds'][number];

	const DEFAULT_QUIET = { start: '22:00', end: '07:00' };
	const HIGHLIGHT_MS = 2000;

	let options = $state<Preferences | null>(null);
	let error = $state<string | null>(null);
	let pushMessage = $state<string | null>(null);
	let quietStart = $state(DEFAULT_QUIET.start);
	let quietEnd = $state(DEFAULT_QUIET.end);
	let highlighted = $state<string | null>(null);

	const available = $derived(options?.channels.filter((c) => c.available) ?? []);
	/** Channels this person cannot be reached through yet, which say what to do about it. */
	const explained = $derived(options?.channels.filter((c) => !c.available && c.hint) ?? []);
	const groups = $derived(groupKinds(options?.kinds ?? []));
	// Three switches or more do not fit beside the text of a narrow card: they go under it.
	const stacked = $derived(available.length >= 3);

	async function loadPrefs() {
		const res = await api.GET('/api/v1/core/notifications/preferences');
		if (!res.data) return;
		options = res.data;
		quietStart = res.data.prefs.quietHours?.start ?? DEFAULT_QUIET.start;
		quietEnd = res.data.prefs.quietHours?.end ?? DEFAULT_QUIET.end;
	}

	$effect(() => {
		if (session.status !== 'ready') return;
		void loadPrefs();
		void push.refresh();
	});

	// A link to one kind (`#kind-<id>`): once the kinds are drawn, bring it into view and mark it.
	const linkedKind = $derived(kindFromHash(page.url.hash));
	// A boolean, so saving a switch (new options) does not scroll and mark the kind again.
	const linkedListed = $derived(
		linkedKind !== null && (options?.kinds.some((k) => k.id === linkedKind) ?? false),
	);
	$effect(() => {
		const id = linkedKind;
		if (!id || !linkedListed) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		void tick().then(() => {
			document.getElementById(kindAnchor(id))?.scrollIntoView({ block: 'center' });
			highlighted = id;
			timer = setTimeout(() => (highlighted = null), HIGHLIGHT_MS);
		});
		return () => clearTimeout(timer);
	});

	/** A kind's link is shown only when it leads to a page of the app this person has. */
	const linkShown = (kind: Kind) =>
		kind.link !== undefined &&
		kind.link.path.startsWith('/') &&
		!kind.link.path.startsWith('//') &&
		isAppPath(kind.link.path.split(/[?#]/)[0] ?? '', session.disabledExtensions);

	async function turnOnPush() {
		pushMessage = null;
		try {
			await push.enable();
			// The phone channel is now available: show its switches.
			await loadPrefs();
		} catch {
			pushMessage = push.permission === 'denied' ? t('push_denied') : t('push_failed');
		}
	}

	async function turnOffPush() {
		pushMessage = null;
		try {
			await push.disable();
			await loadPrefs();
		} catch {
			pushMessage = t('push_failed');
		}
	}

	async function testPush() {
		pushMessage = null;
		try {
			pushMessage = (await push.sendTest()) > 0 ? t('push_test_sent') : t('push_test_none');
		} catch {
			pushMessage = t('push_failed');
		}
	}

	async function save(next: Prefs) {
		error = null;
		const saved = await runAction(
			api.POST('/api/v1/actions/core.setNotificationPreferences', { body: next }),
			{ onError: (failure) => (error = failure.message) },
		);
		if (!saved.ok) await loadPrefs();
		else if (options && saved.data.status === 'applied')
			options = { ...options, prefs: saved.data.output };
	}

	const isOn = (kind: Kind, channelId: string) =>
		options?.prefs.kinds[kind.id]?.[channelId] ?? kind.defaultChannels.includes(channelId);

	function toggleChannel(kindId: string, channelId: string, enabled: boolean) {
		if (!options) return;
		const kind = options.kinds.find((k) => k.id === kindId);
		if (!kind) return;
		// Send the whole kind, so its other channels keep their current (maybe default) state.
		const channels = Object.fromEntries(
			options.channels.map((c) => [c.id, c.id === channelId ? enabled : isOn(kind, c.id)]),
		);
		void save({
			kinds: { [kindId]: channels },
			quietHours: options.prefs.quietHours,
		});
	}

	function setQuiet(on: boolean) {
		if (!options) return;
		void save({
			kinds: {},
			quietHours: on ? { start: quietStart, end: quietEnd } : null,
		});
	}

	function changeQuietTimes() {
		if (!options?.prefs.quietHours || !quietStart || !quietEnd) return;
		void save({ kinds: {}, quietHours: { start: quietStart, end: quietEnd } });
	}

	const added = (at: number) =>
		t('push_device_added', { date: dateTimeFormat({ dateStyle: 'medium' }).format(at) });
</script>

{#snippet deviceRow()}
	<div>
		{#if push.support === 'ios-home-screen'}
			<Row wrap title={t('push_device_title')} meta={t('push_unsupported_ios')} />
		{:else if push.support === 'unsupported'}
			<Row wrap title={t('push_device_title')} meta={t('push_unsupported')} />
		{:else if push.permission === 'denied' && !push.subscribed}
			<Row wrap title={t('push_device_title')} meta={t('push_denied')} />
		{:else if push.subscribed}
			<Row wrap title={t('push_device_title')} meta={t('push_on_here')}>
				{#snippet trail()}
					<Button variant="ghost" size="sm" disabled={push.busy} onclick={testPush}>
						{t('push_send_test')}
					</Button>
					<Button variant="outline" size="sm" disabled={push.busy} onclick={turnOffPush}>
						{t('push_disable')}
					</Button>
				{/snippet}
			</Row>
		{:else}
			<Row wrap title={t('push_device_title')} meta={t('push_device_hint')}>
				{#snippet trail()}
					<!-- The page's one filled button while nothing reaches this person outside the app. -->
					<Button
						variant={options && available.length === 0 ? 'primary' : 'outline'}
						size="sm"
						disabled={push.busy}
						onclick={turnOnPush}>{t('push_enable')}</Button
					>
				{/snippet}
			</Row>
		{/if}
		{#if pushMessage}
			<p class="px-3 pb-2.5 text-[0.8125rem] font-semibold" role="status">{pushMessage}</p>
		{/if}
	</div>
{/snippet}

{#snippet heads()}
	<span class="heads" aria-hidden="true" class:stacked>
		{#each available as channel (channel.id)}
			<span class="head">{channel.label}</span>
		{/each}
	</span>
{/snippet}

<Page template="settings">
	<PageHeader title={t('nav_notifications')} />

	<div class="grid gap-8">
		{#if error}<p class="text-attention font-semibold" role="alert">{error}</p>{/if}

		<Section label={t('notify_where_title')}>
			<Card rows>
				{@render deviceRow()}
				{#each push.devices as device (device.createdAt + device.label)}
					<Row
						wrap
						title={device.label || t('push_device_unknown')}
						meta={added(device.createdAt)}
					/>
				{/each}
				<TelegramLink onchanged={loadPrefs} />
				{#each explained as channel (channel.id)}
					<Row wrap title={channel.label} meta={channel.hint} />
				{/each}
			</Card>
			{#if options && available.length === 0}
				<Notice>{t('notifications_in_app_kinds')}</Notice>
			{/if}
		</Section>

		{#if options}
			<Section label={t('quiet_hours_title')}>
				<Card rows>
					<SwitchRow
						id="quiet-hours-on"
						label={t('quiet_hours_title')}
						hint={t('quiet_hours_hint')}
						checked={options.prefs.quietHours !== null}
						onchange={setQuiet}
					/>
					{#if options.prefs.quietHours}
						<div class="flex flex-wrap items-center gap-4 px-4 py-3">
							<label class="flex items-center gap-2 font-semibold">
								{t('quiet_hours_from')}
								<Input
									type="time"
									class="w-auto"
									bind:value={quietStart}
									onchange={changeQuietTimes}
								/>
							</label>
							<label class="flex items-center gap-2 font-semibold">
								{t('quiet_hours_until')}
								<Input
									type="time"
									class="w-auto"
									bind:value={quietEnd}
									onchange={changeQuietTimes}
								/>
							</label>
						</div>
					{/if}
				</Card>
			</Section>

			{#each groups as part (part.group)}
				<div class="kinds">
					<Section
						label={t(`notify_group_${part.group}`)}
						actions={available.length > 0 ? heads : undefined}
					>
						<Card rows class="overflow-hidden">
							{#each part.kinds as kind (kind.id)}
								<KindRow
									{kind}
									channels={available}
									isOn={(channelId) => isOn(kind, channelId)}
									onchange={(channelId, enabled) => toggleChannel(kind.id, channelId, enabled)}
									linkShown={linkShown(kind)}
									{stacked}
									highlighted={highlighted === kind.id}
								/>
							{/each}
						</Card>
					</Section>
				</div>
			{/each}
		{/if}
	</div>
</Page>

<style>
	/* Narrow cards of three channels or more put the switches under the text (KindRow). */
	.kinds {
		container: notify-kinds / inline-size;
		min-width: 0;
	}
	/* Over the switch columns of the rows: as wide, as far apart, the row's end padding after. */
	.heads {
		display: flex;
		gap: 12px;
		padding-inline-end: 12px;
	}
	.head {
		width: 72px;
		text-align: center;
		font-size: 0.6875rem;
		font-weight: 600;
		line-height: 1.2;
		color: var(--ink-soft);
		/* Never cut: a long word ("Handy-Benachrichtigungen") breaks, hyphenated where the language allows. */
		hyphens: auto;
		overflow-wrap: anywhere;
	}
	@container notify-kinds (max-width: 32rem) {
		.heads.stacked {
			display: none;
		}
	}
</style>
