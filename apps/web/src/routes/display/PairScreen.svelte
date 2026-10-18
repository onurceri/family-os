<script lang="ts">
	import { unwrap } from '@famos/api-client';
	import { Step, Steps } from '@famos/ui/famos';
	import { onDestroy } from 'svelte';
	import { api } from '#lib/api.js';
	import { t } from '#lib/i18n.svelte.js';
	import QrCode from '#lib/QrCode.svelte';

	/**
	 * Pairing by code (RFC 8628): the same numbered steps as "Add a device" in Settings,
	 * seen from the screen. Shows a short code, the address (and its QR code) where an admin
	 * confirms it, and polls until the server hands this browser its device cookie.
	 */
	let { onpaired }: { onpaired: () => void } = $props();

	type Started = { deviceCode: string; userCode: string; expiresAt: number; interval: number };
	let started = $state<Started | null>(null);
	let now = $state(Date.now());
	let failed = $state(false);
	let intervalMs = 5000;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;

	const address = $derived(
		started
			? `${location.origin}/settings/devices?code=${started.userCode}`
			: `${location.origin}/settings/devices`,
	);
	const remaining = $derived(started ? Math.max(0, started.expiresAt - now) : 0);
	const countdown = $derived(
		`${Math.floor(remaining / 60_000)}:${String(Math.floor((remaining % 60_000) / 1000)).padStart(2, '0')}`,
	);

	async function begin() {
		clearTimeout(pollTimer);
		clearTimeout(retryTimer);
		try {
			const next = unwrap(await api.POST('/api/v1/core/displays/pair'));
			if (stopped) return;
			started = next;
			intervalMs = next.interval * 1000;
			failed = false;
			pollTimer = setTimeout(poll, intervalMs);
		} catch {
			if (stopped) return;
			// Offline, or too many codes asked for: wait and try again.
			failed = true;
			retryTimer = setTimeout(begin, 15_000);
		}
	}

	async function poll() {
		if (!started || stopped) return;
		try {
			const result = unwrap(
				await api.POST('/api/v1/core/displays/pair/poll', {
					body: { deviceCode: started.deviceCode },
				}),
			);
			if (stopped) return;
			if (result.status === 'paired') {
				stopped = true;
				onpaired();
				return;
			}
			if (result.status === 'expired') return void begin();
			if (result.status === 'slow_down') intervalMs += 5000;
			failed = false;
		} catch {
			failed = true;
		}
		pollTimer = setTimeout(poll, intervalMs);
	}

	$effect(() => {
		void begin();
		const tick = setInterval(() => {
			now = Date.now();
			// The server would say "expired" too; this just avoids showing a dead code.
			if (started && started.expiresAt <= now && !failed) void begin();
		}, 1000);
		return () => clearInterval(tick);
	});
	onDestroy(() => {
		stopped = true;
		clearTimeout(pollTimer);
		clearTimeout(retryTimer);
	});
</script>

<main class="bg-wall text-ink grid min-h-dvh place-items-center p-8">
	<div class="grid w-full max-w-5xl gap-10">
		<div class="grid gap-2">
			<h1 class="text-5xl font-extrabold text-balance">{t('display_pair_title')}</h1>
			<p class="text-ink-soft text-2xl">{t('display_pair_intro')}</p>
		</div>
		<div class="grid items-center gap-10 md:grid-cols-[minmax(0,1fr)_auto]">
			<Steps current={2} large label={t('display_pair_title')} doneLabel={t('steps_done')}>
				<Step
					n={1}
					title={t('display_pair_step_open')}
					summary={t('display_pair_step_open_done')}
				/>
				<Step n={2} title={t('display_pair_step_code')}>
					<p class="text-ink-soft text-xl">{t('display_pair_open')}</p>
					<p class="text-info text-2xl font-bold break-all" data-testid="pair-address">{address}</p>
					<p
						class="text-7xl font-extrabold tracking-widest tabular-nums"
						aria-live="polite"
						data-testid="pair-code"
					>
						{started?.userCode ?? '····-····'}
					</p>
					{#if started}
						<p class="text-ink-soft text-xl">{t('display_pair_expires', { time: countdown })}</p>
					{/if}
				</Step>
				<Step n={3} title={t('display_pair_step_choose')} />
				<Step n={4} title={t('display_pair_step_done')} />
			</Steps>
			<div class="bg-surface shadow-lit grid justify-items-center gap-3 rounded-2xl p-6">
				<QrCode
					text={address}
					label={t('display_pair_qr')}
					class="w-72 max-w-full"
					testid="pair-qr"
				/>
				<p class="text-ink-soft max-w-72 text-center text-lg">{t('display_pair_scan')}</p>
			</div>
		</div>
		<p class="text-ink-soft text-xl" role="status">
			{failed ? t('display_unreachable') : t('display_pair_waiting')}
		</p>
	</div>
</main>
