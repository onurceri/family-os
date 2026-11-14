<script lang="ts">
	import { Step, Steps } from '@famos/ui/famos';
	import { api } from '#lib/api.js';
	import { runAction } from '#lib/run-action.js';
	import { t } from '#lib/i18n.svelte.js';
	import QrCode from '#lib/QrCode.svelte';
	import { createPairing, type Started } from './pairing.js';

	/**
	 * Pairing by code (RFC 8628): the same numbered steps as "Add a device" in Settings,
	 * seen from the screen. Shows a short code, the address (and its QR code) where an admin
	 * confirms it, and polls until the server hands this browser its device cookie.
	 */
	let { onpaired }: { onpaired: () => void } = $props();

	let started = $state<Started | null>(null);
	let now = $state(Date.now());
	let failed = $state(false);

	const address = $derived(
		started
			? `${location.origin}/settings/devices?code=${started.userCode}`
			: `${location.origin}/settings/devices`,
	);
	const remaining = $derived(started ? Math.max(0, started.expiresAt - now) : 0);
	const countdown = $derived(
		`${Math.floor(remaining / 60_000)}:${String(Math.floor((remaining % 60_000) / 1000)).padStart(2, '0')}`,
	);

	$effect(() => {
		const pairing = createPairing({
			mint: () => runAction(api.POST('/api/v1/core/displays/pair'), { onError: () => {} }),
			poll: (deviceCode) =>
				runAction(api.POST('/api/v1/core/displays/pair/poll', { body: { deviceCode } }), {
					onError: () => {},
				}),
			now: () => Date.now(),
			setTimeout: (run, ms) => setTimeout(run, ms),
			clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
			setInterval: (run, ms) => setInterval(run, ms),
			clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
			onChange: (view) => {
				started = view.started;
				now = view.now;
				failed = view.failed;
			},
			// Read when it happens, so a new handler from the parent never restarts the pairing.
			onPaired: () => onpaired(),
		});
		pairing.start();
		return () => pairing.stop();
	});
</script>

<main class="bg-wall text-ink min-h-viewport grid place-items-center p-8">
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
