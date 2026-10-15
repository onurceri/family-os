<script lang="ts">
	import { Button } from '@famos/ui/button';
	import {
		Avatar,
		Card,
		Notice,
		Page,
		PageHeader,
		Row,
		Section,
		SettingRow,
	} from '@famos/ui/famos';
	import { api } from '#lib/api.js';
	import { signOut } from '#lib/auth.js';
	import { family } from '#lib/family.svelte.js';
	import { getLanguages, t, tDynamic } from '#lib/i18n.svelte.js';
	import SelectField from '#lib/SelectField.svelte';
	import { session } from '#lib/session.svelte.js';

	/**
	 * Profile & sign-in: who you are, how you sign in, your own
	 * language (saved as you choose it) and signing out.
	 */
	const familyLanguage = $derived(
		getLanguages().find((l) => l.code === family.locale)?.nativeName ?? family.locale,
	);
	const BUILT_IN = ['admin', 'member', 'supervised', 'guest'];
	const role = $derived(
		session.me && BUILT_IN.includes(session.me.roleId)
			? tDynamic(`app:role_${session.me.roleId}`)
			: '',
	);
	/** How you really sign in: the logins you have, not what your role allows. */
	const signsInWith = $derived.by(() => {
		const how = session.me?.signIn;
		if (how?.password && how.pin) return t('members_signin_both');
		if (how?.pin) return t('members_signin_pin_family');
		return t('members_signin_password');
	});
	const mayManage = $derived(session.can('core.members.manage'));

	/** "My language": empty follows the family. The layout applies it once saved. */
	async function chooseLanguage(code: string) {
		const res = await api.POST('/api/v1/actions/core.setMyLanguage', {
			body: { locale: code === '' ? null : code },
		});
		if (res.response.ok) await session.refresh();
	}

	async function logout() {
		await signOut();
		await session.refresh();
	}

	/** Ends this member's sessions on every device, this one included. */
	async function logoutEverywhere() {
		await api.POST('/api/v1/core/sessions/end');
		await session.refresh();
	}
</script>

<Page template="settings">
	<PageHeader title={t('nav_profile')} />

	{#if session.me}
		{@const me = session.me}
		<div class="grid gap-7">
			<Card>
				<Row
					title={session.me.displayName}
					meta={[role, session.me.about].filter(Boolean).join(' · ') || undefined}
					class="min-h-[72px]"
				>
					{#snippet lead()}<Avatar name={me.displayName} color={me.color} size={48} />{/snippet}
				</Row>
			</Card>

			<Section label={t('profile_language_title')}>
				<Card rows>
					<SettingRow label={t('my_language')} for="my-language" hint={t('my_language_hint')}>
						{#snippet control()}
							<SelectField
								id="my-language"
								value={session.me?.locale ?? ''}
								onchange={(e) => chooseLanguage(e.currentTarget.value)}
							>
								<option value="">{t('my_language_default', { name: familyLanguage })}</option>
								{#each getLanguages() as language (language.code)}
									<option value={language.code} lang={language.code}>{language.nativeName}</option>
								{/each}
							</SelectField>
						{/snippet}
					</SettingRow>
				</Card>
				<p class="text-ink-soft px-1 text-[13px]">{t('settings_saved_as_you_go')}</p>
			</Section>

			<Section label={t('members_signin_title')}>
				<Card rows>
					<Row title={t('profile_signs_in_with')} meta={signsInWith} />
					<Row title={t('sign_out')} meta={t('sign_out_hint')} onclick={logout} />
					<Row
						title={t('sign_out_everywhere')}
						meta={t('sign_out_everywhere_hint')}
						onclick={logoutEverywhere}
						class="text-destructive"
					/>
				</Card>
				{#if mayManage}
					<Notice tone="info">
						{t('profile_change_signin_admin')}
						<a class="text-info font-semibold underline underline-offset-2" href="/settings/members"
							>{t('nav_members')}</a
						>
					</Notice>
				{:else}
					<Notice tone="info">{t('profile_change_signin')}</Notice>
				{/if}
			</Section>
		</div>
	{/if}
</Page>
