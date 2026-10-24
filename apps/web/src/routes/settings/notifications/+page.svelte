<script lang="ts">
	import { dateTimeFormat } from '#lib/format.svelte.js';
	import { type paths } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import { Card, Page, PageHeader, Section, SwitchRow } from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { api } from '#lib/api.js';
	import { runAction } from '#lib/run-action.js';
	import { t } from '#lib/i18n.svelte.js';
	import { push } from '#lib/push.svelte.js';
	import { session } from '#lib/session.svelte.js';
	import TelegramLink from './TelegramLink.svelte';

	/** Notification settings: this device, Telegram, quiet hours and what goes where. */
	type Json<P extends keyof paths, M extends 'get'> = paths[P][M] extends {
		responses: { 200: { content: { 'application/json': infer R } } };
	}
		? R
		: never;
	type Preferences = Json<'/api/v1/core/notifications/preferences', 'get'>;
	type Prefs = Preferences['prefs'];

	const DEFAULT_QUIET = { start: '22:00', end: '07:00' };

	let options = $state<Preferences | null>(null);
	let error = $state<string | null>(null);
	let pushMessage = $state<string | null>(null);
	let quietStart = $state(DEFAULT_QUIET.start);
	let quietEnd = $state(DEFAULT_QUIET.end);

	const available = $derived(options?.channels.filter((c) => c.available) ?? []);
	/** Channels this person cannot be reached through yet, which say what to do about it. */
	const explained = $derived(options?.channels.filter((c) => !c.available && c.hint) ?? []);

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

	const isOn = (kind: Preferences['kinds'][number], channelId: string) =>
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
</script>

<Page template="settings">
	<PageHeader title={t('nav_notifications')} />

	<div class="grid gap-8">
		{#if error}<p class="text-attention font-semibold" role="alert">{error}</p>{/if}

		<Section label={t('push_device_title')}>
			<Card rows>
				<div class="grid gap-3 px-4 py-3">
					{#if push.support === 'ios-home-screen'}
						<p class="text-ink-soft max-w-prose text-sm">{t('push_unsupported_ios')}</p>
					{:else if push.support === 'unsupported'}
						<p class="text-ink-soft max-w-prose text-sm">{t('push_unsupported')}</p>
					{:else if push.permission === 'denied' && !push.subscribed}
						<p class="text-ink-soft max-w-prose text-sm">{t('push_denied')}</p>
					{:else if push.subscribed}
						<p class="font-medium">{t('push_on_here')}</p>
						<div class="flex flex-wrap gap-2">
							<Button variant="outline" disabled={push.busy} onclick={testPush}>
								{t('push_send_test')}
							</Button>
							<Button variant="outline" disabled={push.busy} onclick={turnOffPush}>
								{t('push_disable')}
							</Button>
						</div>
					{:else}
						<p class="text-ink-soft max-w-prose text-sm">{t('push_device_hint')}</p>
						<div>
							<Button disabled={push.busy} onclick={turnOnPush}>{t('push_enable')}</Button>
						</div>
					{/if}
					{#if pushMessage}<p class="text-sm font-semibold" role="status">{pushMessage}</p>{/if}
				</div>
			</Card>
		</Section>

		<TelegramLink onchanged={loadPrefs} />

		{#if push.devices.length > 0}
			<Section label={t('push_devices_title')}>
				<Card rows>
					{#each push.devices as device (device.createdAt + device.label)}
						<div class="grid gap-0.5 px-4 py-3">
							<span class="font-medium">{device.label || t('push_device_unknown')}</span>
							<small class="text-ink-soft text-xs">
								{t('push_device_added', {
									date: dateTimeFormat({ dateStyle: 'medium' }).format(device.createdAt),
								})}
							</small>
						</div>
					{/each}
				</Card>
			</Section>
		{/if}

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

			{#if explained.length > 0}
				<Section label={t('channels_unavailable_title')}>
					<Card rows>
						{#each explained as channel (channel.id)}
							<div class="grid gap-0.5 px-4 py-3">
								<span class="font-medium">{channel.label}</span>
								<small class="text-ink-soft text-xs">{channel.hint}</small>
							</div>
						{/each}
					</Card>
				</Section>
			{/if}

			{#if available.length === 0}
				<p class="text-ink-soft max-w-prose px-1 text-sm">{t('notifications_in_app_only')}</p>
			{:else}
				{#each options.kinds as kind (kind.id)}
					<Section label={kind.label}>
						<Card rows>
							{#each available as channel (channel.id)}
								<SwitchRow
									id="pref-{kind.id}-{channel.id}"
									label={channel.label}
									checked={isOn(kind, channel.id)}
									onchange={(enabled) => toggleChannel(kind.id, channel.id, enabled)}
								/>
							{/each}
						</Card>
					</Section>
				{/each}
			{/if}
		{/if}
	</div>
</Page>
