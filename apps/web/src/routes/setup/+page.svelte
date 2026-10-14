<script lang="ts">
	import { page } from '$app/state';
	import { isApiError, unwrap } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { api } from '#lib/api.js';
	import { signInWithPassword } from '#lib/auth.js';
	import { family } from '#lib/family.svelte.js';
	import { dateTimeFormat, numberFormat } from '#lib/format.svelte.js';
	import { getLanguages, getLocale, setLocale, t } from '#lib/i18n.svelte.js';
	import { session } from '#lib/session.svelte.js';
	import { contributions, enabledOnly } from '#lib/extensions.js';
	import Slot from '@famos/ui/slot';
	import type { SlotContribution } from '@famos/ui/slots';

	/** Setup starts with the language; the rest of it continues in the chosen one. */
	let step = $state<'language' | 'account' | 'more'>('language');
	// Optional steps that extensions offer once the account exists (`setup.step`), one at a time.
	// They are not filtered by `requires`: the session's capabilities are not loaded yet, and the
	// founder holds all of them.
	let extraSteps = $state<SlotContribution<'setup.step'>[]>([]);
	let extraIndex = $state(0);

	function next() {
		if (extraIndex + 1 < extraSteps.length) extraIndex += 1;
		// The layout guard sends a ready session on /setup to the start page.
		else void session.refresh();
	}
	let displayName = $state('');
	let email = $state('');
	let password = $state('');
	let sharedDevice = $state(false);
	let setupCode = $state(page.url.searchParams.get('code') ?? '');
	let busy = $state(false);
	let error = $state<string | null>(null);
	// The region formats come from the browser; the person can change them in More → Region and formats later.
	const sample = Date.UTC(2026, 9, 8, 14, 30);
	const regionPreview = $derived(
		[
			dateTimeFormat({ dateStyle: 'full', timeZone: family.timeZone }).format(sample),
			dateTimeFormat({ hour: '2-digit', minute: '2-digit', timeZone: family.timeZone }).format(
				sample,
			),
		].join(' · '),
	);

	const clockOptions = $derived(
		(['h23', 'h12'] as const).map((hourCycle) => ({
			hourCycle,
			label: dateTimeFormat({
				hour: 'numeric',
				minute: '2-digit',
				hourCycle,
				timeZone: family.timeZone,
			}).format(sample),
		})),
	);

	const temperatureOptions = $derived(
		(['celsius', 'fahrenheit'] as const).map((unit) => ({
			unit,
			label: numberFormat({ style: 'unit', unit }).format(unit === 'celsius' ? 21 : 70),
		})),
	);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = null;
		try {
			unwrap(
				await api.POST('/api/v1/core/setup', {
					body: {
						displayName,
						email,
						password,
						locale: getLocale(),
						timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
						formatLocale: family.formatLocale,
						weekStart: family.weekStart,
						hourCycle: family.hourCycle,
						temperatureUnit: family.temperatureUnit,
						...(session.setupNeedsCode && { setupCode: setupCode.trim() }),
					},
				}),
			);
			await signInWithPassword(email, password);
			if (sharedDevice) {
				await api.POST('/api/v1/core/devices/trust', { body: { name: t('setup_device_name') } });
			}
			extraSteps = enabledOnly(contributions.slots, session.disabledExtensions)
				.filter((c): c is SlotContribution<'setup.step'> => c.slot === 'setup.step')
				.toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0));
			if (extraSteps.length > 0) step = 'more';
			else await session.refresh();
		} catch (e) {
			error = isApiError(e) && e.code === 'forbidden' ? t('setup_code_wrong') : t('error_generic');
		} finally {
			busy = false;
		}
	}
</script>

<section
	class="bg-surface shadow-lit mx-auto mt-6 grid max-w-md gap-5 rounded-xl p-6"
	aria-labelledby={step === 'more' ? undefined : 'setup-title'}
>
	{#if step === 'language'}
		<div class="grid gap-2">
			<h1 id="setup-title" class="text-2xl font-extrabold tracking-tight">
				{t('setup_language_title')}
			</h1>
			<p class="text-ink-soft">{t('setup_language_intro')}</p>
		</div>
		<div class="grid gap-2" role="radiogroup" aria-label={t('language')}>
			{#each getLanguages() as language (language.code)}
				<button
					type="button"
					role="radio"
					aria-checked={getLocale() === language.code}
					lang={language.code}
					dir={language.dir}
					class="flex min-h-12 items-center justify-between gap-3 rounded-lg border px-4 py-2 text-left {getLocale() ===
					language.code
						? 'bg-idle border-ink'
						: 'bg-surface'}"
					onclick={() => {
						void setLocale(language.code, { remember: true });
						family.defaultsFor(language.code);
					}}
				>
					<span class="font-semibold">{language.nativeName}</span>
					{#if language.name !== language.nativeName}
						<span class="text-ink-soft text-sm">{language.name}</span>
					{/if}
				</button>
			{/each}
		</div>
		<Button
			type="button"
			onclick={() => {
				family.defaultsFor(getLocale());
				step = 'account';
			}}>{t('setup_continue')}</Button
		>
	{:else if step === 'more'}
		{#key extraIndex}
			<Slot
				name="setup.step"
				contributions={extraSteps.slice(extraIndex, extraIndex + 1)}
				props={{ done: next }}
			/>
		{/key}
	{:else}
		<div class="grid gap-2">
			<h1 id="setup-title" class="text-2xl font-extrabold tracking-tight">{t('setup_title')}</h1>
			<p class="text-ink-soft">{t('setup_intro')}</p>
		</div>
		<form class="grid gap-4" onsubmit={submit}>
			<p class="text-ink-soft text-xs" data-testid="setup-region">
				{t('setup_region', { preview: regionPreview })}
			</p>
			{#snippet choice(
				id: string,
				label: string,
				options: { value: string; label: string }[],
				current: string,
				pick: (value: string) => void,
			)}
				<div class="grid gap-2">
					<p {id} class="text-sm font-semibold">{label}</p>
					<div class="grid grid-cols-2 gap-2" role="radiogroup" aria-labelledby={id}>
						{#each options as option (option.value)}
							<button
								type="button"
								role="radio"
								aria-checked={current === option.value}
								class="min-h-12 rounded-lg border px-4 py-2 font-semibold {current === option.value
									? 'bg-idle border-ink'
									: 'bg-surface'}"
								onclick={() => pick(option.value)}
							>
								{option.label}
							</button>
						{/each}
					</div>
				</div>
			{/snippet}
			{@render choice(
				'setup-clock-label',
				t('setup_clock'),
				clockOptions.map((o) => ({ value: o.hourCycle, label: o.label })),
				family.hourCycle,
				(value) => (family.hourCycle = value as typeof family.hourCycle),
			)}
			{@render choice(
				'setup-temperature-label',
				t('setup_temperature'),
				temperatureOptions.map((o) => ({ value: o.unit, label: o.label })),
				family.temperatureUnit,
				(value) => (family.temperatureUnit = value as typeof family.temperatureUnit),
			)}
			{#if session.setupNeedsCode}
				<div class="grid gap-2">
					<Label for="setup-code">{t('setup_code')}</Label>
					<Input
						id="setup-code"
						bind:value={setupCode}
						required
						autocomplete="off"
						spellcheck={false}
					/>
					<p class="text-ink-soft text-xs">{t('setup_code_hint')}</p>
				</div>
			{/if}
			<div class="grid gap-2">
				<Label for="name">{t('setup_name')}</Label>
				<Input id="name" bind:value={displayName} required maxlength={60} autocomplete="name" />
			</div>
			<div class="grid gap-2">
				<Label for="email">{t('setup_email')}</Label>
				<Input id="email" type="email" bind:value={email} required autocomplete="email" />
			</div>
			<div class="grid gap-2">
				<Label for="password">{t('setup_password')}</Label>
				<Input
					id="password"
					type="password"
					bind:value={password}
					required
					minlength={10}
					autocomplete="new-password"
				/>
				<p class="text-ink-soft text-xs">{t('setup_password_hint')}</p>
			</div>
			<label
				class="bg-idle flex cursor-pointer items-start gap-3 rounded-lg p-3 text-sm"
				for="shared-device"
			>
				<input
					id="shared-device"
					type="checkbox"
					class="mt-0.5 size-4 accent-current"
					bind:checked={sharedDevice}
				/>
				<span>{t('setup_shared_device')}</span>
			</label>
			{#if error}<p class="text-attention text-sm font-semibold" role="alert">{error}</p>{/if}
			<Button type="submit" disabled={busy}>{t('setup_submit')}</Button>
			<Button type="button" variant="ghost" onclick={() => (step = 'language')}
				>{t('setup_change_language')}</Button
			>
		</form>
	{/if}
</section>
