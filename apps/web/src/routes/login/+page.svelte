<script lang="ts">
	import { Delete } from '@lucide/svelte';
	import { Button } from '@famos/ui/button';
	import { Avatar } from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { api } from '#lib/api.js';
	import { type SignInResult, signInWithPassword, signInWithPin } from '#lib/auth.js';
	import { getLanguages, getLocale, setLocale, t } from '#lib/i18n.svelte.js';
	import { session } from '#lib/session.svelte.js';

	type Profile = { id: string; displayName: string; color: string };

	let profiles = $state<Profile[]>([]);
	let selected = $state<Profile | null>(null);
	let mode = $state<'profiles' | 'pin' | 'email'>('profiles');
	let pin = $state('');
	let email = $state('');
	let password = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);
	/** Profiles and PINs are only offered on family devices. */
	let trustedDevice = $state(true);

	const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'] as const;

	$effect(() => {
		void api.GET('/api/v1/core/profiles').then((r) => {
			profiles = r.data ?? [];
			if (r.response.status === 401) {
				trustedDevice = false;
				mode = 'email';
			} else if (profiles.length === 0) {
				// Nobody here signs in with a PIN (for example a household of adults).
				mode = 'email';
			}
		});
	});

	function message(result: SignInResult, invalid: string, locked: 'pin' | 'email') {
		if (result.kind === 'locked')
			return t(locked === 'pin' ? 'login_pin_locked' : 'login_locked', {
				count: result.minutes,
			});
		if (result.kind === 'limited') return t('login_limited', { count: result.minutes });
		if (result.kind === 'untrusted') return t('login_untrusted');
		if (result.kind === 'invalid') return invalid;
		return t('error_generic');
	}

	async function finish(result: SignInResult, invalid: string, locked: 'pin' | 'email') {
		busy = false;
		if (result.kind === 'ok') await session.refresh();
		else {
			error = message(result, invalid, locked);
			pin = '';
		}
	}

	async function submitPin() {
		if (!selected || pin.length < 4) return;
		busy = true;
		error = null;
		await finish(await signInWithPin(selected.id, pin), t('login_pin_failed'), 'pin');
	}

	async function submitEmail(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = null;
		await finish(await signInWithPassword(email, password), t('login_failed'), 'email');
	}

	function press(key: (typeof KEYS)[number]) {
		error = null;
		if (key === 'ok') void submitPin();
		else if (key === 'del') pin = pin.slice(0, -1);
		else if (pin.length < 6) pin += key;
	}

	function choose(profile: Profile) {
		selected = profile;
		mode = 'pin';
		pin = '';
		error = null;
	}

	function back() {
		mode = 'profiles';
		selected = null;
		pin = '';
		error = null;
	}

	const keyLabel = (key: (typeof KEYS)[number]) =>
		key === 'del' ? t('login_delete') : key === 'ok' ? t('login_submit') : key;
</script>

<div class="mx-auto grid max-w-lg gap-6 pt-6">
	{#if getLanguages().length > 1}
		<!-- Before sign-in the language is this device's choice; afterwards it is the person's. -->
		<div class="flex items-center justify-end gap-2">
			<label for="login-language" class="text-ink-soft text-sm font-semibold">{t('language')}</label
			>
			<select
				id="login-language"
				class="bg-wall min-h-9 rounded-lg border px-2 text-sm"
				value={getLocale()}
				onchange={(e) => setLocale(e.currentTarget.value, { remember: true })}
			>
				{#each getLanguages() as language (language.code)}
					<option value={language.code} lang={language.code}>{language.nativeName}</option>
				{/each}
			</select>
		</div>
	{/if}
	{#if mode === 'profiles'}
		{#if session.familyName}
			<p class="text-ink-soft text-center text-lg font-semibold" data-testid="family-name">
				{session.familyName}
			</p>
		{/if}
		<h1 class="text-center text-2xl font-extrabold tracking-tight">{t('login_title')}</h1>
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
			{#each profiles as profile (profile.id)}
				<button
					type="button"
					class="bg-surface shadow-lit flex min-h-36 flex-col items-center justify-center gap-3 rounded-xl p-4 text-lg font-bold"
					onclick={() => choose(profile)}
				>
					<Avatar name={profile.displayName} color={profile.color} size={64} />
					{profile.displayName}
				</button>
			{/each}
		</div>
		<Button variant="link" class="justify-self-center" onclick={() => (mode = 'email')}>
			{t('login_adult')}
		</Button>
	{:else if mode === 'pin' && selected}
		<section
			class="bg-surface shadow-lit mx-auto grid w-full max-w-xs gap-5 rounded-xl p-5"
			aria-labelledby="pin-title"
		>
			<div class="grid justify-items-center gap-3">
				<Avatar name={selected.displayName} color={selected.color} size={56} />
				<h1 id="pin-title" class="text-center text-lg font-extrabold">
					{t('login_pin_for', { name: selected.displayName })}
				</h1>
				<div class="flex gap-2" aria-hidden="true">
					{#each Array.from({ length: 6 }) as _, i (i)}
						<span
							class="size-3 rounded-full border-2 {i < pin.length
								? 'bg-ink border-ink'
								: 'border-line'}"
						></span>
					{/each}
				</div>
			</div>
			<div class="grid grid-cols-3 gap-2">
				{#each KEYS as key (key)}
					<button
						type="button"
						disabled={busy || (key === 'ok' && pin.length < 4)}
						onclick={() => press(key)}
						aria-label={keyLabel(key)}
						class="flex min-h-14 items-center justify-center rounded-lg text-xl font-bold disabled:opacity-40 {key ===
						'ok'
							? 'bg-ink text-wall'
							: 'bg-idle text-ink'}"
					>
						{#if key === 'del'}<Delete
								class="size-6"
								aria-hidden="true"
							/>{:else if key === 'ok'}✓{:else}{key}{/if}
					</button>
				{/each}
			</div>
			{#if error}<p class="text-attention text-center text-sm font-semibold" role="alert">
					{error}
				</p>{/if}
			<Button variant="ghost" onclick={back}>{t('login_back')}</Button>
		</section>
	{:else}
		{#if !trustedDevice}
			<p class="bg-idle text-ink-soft rounded-xl px-4 py-3 text-sm">{t('login_untrusted')}</p>
		{/if}
		<section class="bg-surface shadow-lit grid gap-4 rounded-xl p-5" aria-labelledby="email-title">
			<h1 id="email-title" class="text-lg font-extrabold">{t('login_adult')}</h1>
			<form class="grid gap-4" onsubmit={submitEmail}>
				<div class="grid gap-2">
					<Label for="email">{t('login_email')}</Label>
					<Input id="email" type="email" bind:value={email} required autocomplete="username" />
				</div>
				<div class="grid gap-2">
					<Label for="password">{t('login_password')}</Label>
					<Input
						id="password"
						type="password"
						bind:value={password}
						required
						autocomplete="current-password"
					/>
				</div>
				{#if error}<p class="text-attention text-sm font-semibold" role="alert">{error}</p>{/if}
				<Button type="submit" disabled={busy}>{t('login_submit')}</Button>
				{#if trustedDevice}
					<Button type="button" variant="ghost" onclick={back}>{t('login_back')}</Button>
				{/if}
			</form>
		</section>
	{/if}
</div>
