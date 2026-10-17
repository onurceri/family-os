<script lang="ts">
	import { isApiError, type paths, unwrap } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import {
		Avatar,
		Card,
		ConfirmButton,
		IconButton,
		Page,
		PageHeader,
		Pill,
		Row,
		Section,
		SidePanel,
		wide,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { ChevronRight, Pencil, Plus, ShieldCheck } from '@lucide/svelte';
	import { api } from '#lib/api.js';
	import { family } from '#lib/family.svelte.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import { onEvent } from '#lib/realtime.js';
	import RowMenu from '#lib/RowMenu.svelte';
	import SelectField from '#lib/SelectField.svelte';
	import { session } from '#lib/session.svelte.js';
	import { toasts } from '#lib/toast.svelte.js';

	/**
	 * Members: one row per person with the role as a pill and a
	 * `...` menu; adding, editing and the sign-in live in one panel (a sheet on phones); a roles
	 * summary sits below, or beside from 80 rem.
	 */
	type Member =
		paths['/api/v1/core/members']['get']['responses'][200]['content']['application/json'][number];
	type Roles = paths['/api/v1/core/roles']['get']['responses'][200]['content']['application/json'];

	const PIN = 'core.signIn.pin';
	/** What a PIN sign-in can never do; a role that holds it is told so beside the PIN. */
	const ADMINISTERS = 'core.members.manage';
	// The members come from the shell, which reads them once and again on every member event.
	const members = $derived<Member[]>(family.members);
	let roles = $state<Roles['roles']>([]);
	let rolesLoaded = $state(false);
	const loaded = $derived(family.loaded && rolesLoaded);

	/** The open panel: a new member (`add`) or one member (edit and sign-in together). */
	let panel = $state<{ memberId: string | null } | null>(null);
	let name = $state('');
	let roleId = $state('member');
	let about = $state('');
	let pin = $state('');
	let email = $state('');
	let password = $state('');
	let error = $state<string | null>(null);
	let saving = $state(false);
	let formEl = $state<HTMLFormElement>();

	const editing = $derived(panel?.memberId ? members.find((m) => m.id === panel?.memberId) : null);
	const roleName = (id: string) => {
		const role = roles.find((r) => r.id === id);
		return role?.name ?? tDynamic(`app:role_${id}`);
	};
	const roleHint = (id: string) => {
		const role = roles.find((r) => r.id === id);
		if (!role || role.builtIn) return tDynamic(`app:role_${id}_hint`);
		return t('role_custom_hint', { base: tDynamic(`app:role_${role.base}`) });
	};
	const holds = (id: string, capability: string) =>
		roles.find((r) => r.id === id)?.capabilities.includes(capability) ?? false;
	/** Whether the role lets a person have a PIN (every built-in role does). */
	const mayUsePin = (id: string) => holds(id, PIN);
	/** How the person really signs in, from the logins they have (not from the role). */
	const signIn = (member: Member) => {
		const how = member.signIn;
		if (!how) return null;
		if (how.password && how.pin) return t('members_signin_both');
		if (how.password) return t('members_signin_password');
		if (how.pin) return t('members_signin_pin_family');
		return t('members_signin_none');
	};

	const dirty = $derived(
		panel !== null &&
			(editing
				? name.trim() !== editing.displayName ||
					roleId !== editing.roleId ||
					about.trim() !== (editing.about ?? '') ||
					pin !== '' ||
					email !== '' ||
					password !== ''
				: name !== '' || about !== '' || pin !== '' || email !== '' || password !== ''),
	);

	/** The roles, with how many people hold each one. */
	async function loadRoles() {
		const r = await api.GET('/api/v1/core/roles');
		roles = r.data?.roles ?? [];
		rolesLoaded = true;
	}
	/** After a change made here that sends no event (a PIN, a password): members and roles again. */
	async function load() {
		await Promise.all([family.refresh(), loadRoles()]);
	}

	$effect(() => {
		if (!session.can('core.members.manage')) return;
		void loadRoles();
		// The shell reads the members again on a member event; the role counts change with them.
		const offMembers = onEvent('core.member.', () => void loadRoles());
		const offRoles = onEvent('core.role.', () => void loadRoles());
		return () => {
			offMembers();
			offRoles();
		};
	});

	/** Sets the sign-in typed in the panel; returns whether anything was saved. */
	async function saveSignIn(memberId: string, role: string): Promise<boolean> {
		let saved = false;
		if (email || password) {
			unwrap(
				await api.PUT('/api/v1/core/members/{memberId}/password', {
					params: { path: { memberId } },
					body: { email, password },
				}),
			);
			email = password = '';
			saved = true;
		}
		if (pin && mayUsePin(role)) {
			unwrap(
				await api.PUT('/api/v1/core/members/{memberId}/pin', {
					params: { path: { memberId } },
					body: { pin },
				}),
			);
			pin = '';
			saved = true;
		}
		return saved;
	}

	/** A specific message for the refusals people can run into; anything else is generic. */
	function errorText(e: unknown) {
		const reason =
			isApiError(e) && typeof e.details === 'object' && e.details !== null && 'reason' in e.details
				? e.details.reason
				: null;
		if (reason === 'last_admin') return t('members_err_last_admin');
		if (reason === 'email_taken') return t('members_err_email_taken');
		return t('error_generic');
	}

	function openAdd() {
		name = '';
		roleId = 'member';
		about = '';
		pin = email = password = '';
		error = null;
		panel = { memberId: null };
	}

	function openEdit(member: Member) {
		name = member.displayName;
		roleId = member.roleId;
		about = member.about ?? '';
		pin = email = password = '';
		error = null;
		panel = { memberId: member.id };
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!panel || saving) return;
		saving = true;
		error = null;
		try {
			if (!editing) {
				const created = unwrap(
					await api.POST('/api/v1/actions/core.createMember', {
						body: {
							displayName: name.trim(),
							roleId,
							...(about.trim() && { about: about.trim() }),
						},
					}),
				);
				if (created.status === 'applied') {
					// From here on the panel is the new person's: if their sign-in is refused (an email
					// already used), it stays open on them with the message, and Save tries again.
					await load();
					panel = { memberId: created.output.id };
					const withSignIn = await saveSignIn(created.output.id, roleId);
					toasts.show(
						t(withSignIn ? 'members_added_with_signin' : 'members_added', { name: name.trim() }),
					);
				}
			} else {
				unwrap(
					await api.POST('/api/v1/actions/core.updateMember', {
						body: {
							memberId: editing.id,
							displayName: name.trim(),
							roleId,
							about: about.trim() || null,
						},
					}),
				);
				// The sign-in is only changed when something was typed for it.
				toasts.show(
					(await saveSignIn(editing.id, roleId))
						? t('members_login_saved')
						: t('members_saved', { name: name.trim() }),
				);
			}
			panel = null;
			await load();
		} catch (e) {
			error = errorText(e);
		} finally {
			saving = false;
		}
	}

	async function remove(member: Member) {
		try {
			unwrap(
				await api.POST('/api/v1/actions/core.archiveMember', { body: { memberId: member.id } }),
			);
			toasts.show(t('members_removed', { name: member.displayName }));
			panel = null;
			await load();
		} catch (e) {
			error = errorText(e);
		}
	}
</script>

{#snippet pencil()}<Pencil class="size-4" />{/snippet}

<Page template="settings">
	<PageHeader title={t('members_title')}>
		{#snippet actions()}
			{#if wide.current}
				<Button variant="primary" onclick={openAdd}
					><Plus aria-hidden="true" />{t('members_add_button')}</Button
				>
			{:else}
				<IconButton variant="primary" label={t('members_add_button')} onclick={openAdd}>
					<Plus class="size-5" aria-hidden="true" />
				</IconButton>
			{/if}
		{/snippet}
	</PageHeader>

	<div class="settings-pair grid items-start gap-8 @[80rem]:grid-cols-2">
		<div class="grid gap-3">
			<Section label={t('members_title')} count={members.length}>
				<Card rows data-testid="members-list">
					{#each members as member (member.id)}
						<Row
							title={member.id === session.me?.id
								? `${member.displayName} · ${t('members_you')}`
								: member.displayName}
							meta={[
								wide.current ? null : roleName(member.roleId),
								signIn(member),
								member.about ? t('members_about_meta', { about: member.about }) : null,
							]
								.filter(Boolean)
								.join(' · ')}
							onclick={wide.current ? undefined : () => openEdit(member)}
							data-testid="member-row"
						>
							{#snippet lead()}<Avatar
									name={member.displayName}
									color={member.color}
									size={40}
								/>{/snippet}
							{#snippet trail()}
								{#if wide.current}
									<Pill>{roleName(member.roleId)}</Pill>
									<RowMenu
										name={member.displayName}
										items={[
											{
												id: 'edit',
												label: t('members_edit'),
												icon: pencil,
												onselect: () => openEdit(member),
											},
										]}
									/>
								{:else}
									<ChevronRight class="text-ink-soft size-4" aria-hidden="true" />
								{/if}
							{/snippet}
						</Row>
					{/each}
				</Card>
			</Section>
			<p class="text-ink-soft px-1 text-[13px]">
				{t('members_pin_hint')}
				<a class="text-info font-semibold underline underline-offset-2" href="/settings/devices"
					>{t('nav_devices_displays')}</a
				>
			</p>
		</div>

		<Section label={t('nav_roles')}>
			{#snippet actions()}
				<Button variant="ghost" size="sm" href="/settings/roles"
					>{t('members_open_roles')}<ChevronRight class="size-4" aria-hidden="true" /></Button
				>
			{/snippet}
			<Card rows data-testid="roles-summary">
				{#each roles as role (role.id)}
					<Row
						href="/settings/roles"
						title={role.name ?? tDynamic(`app:role_${role.id}`)}
						meta="{role.builtIn
							? tDynamic(`app:role_${role.id}_hint`)
							: t('role_custom_hint', {
									base: tDynamic(`app:role_${role.base}`),
								})} · {role.members === 0
							? t('roles_nobody')
							: t('roles_people', { count: role.members })}"
					>
						{#snippet lead()}
							<ShieldCheck class="size-[18px]" aria-hidden="true" />
						{/snippet}
						{#snippet trail()}
							{#if !wide.current}<ChevronRight
									class="text-ink-soft size-4"
									aria-hidden="true"
								/>{/if}
						{/snippet}
					</Row>
				{/each}
			</Card>
		</Section>
	</div>

	<SidePanel
		open={panel !== null}
		title={editing ? editing.displayName : t('members_add')}
		closeLabel={t('side_panel_close')}
		cancelLabel={t('cancel')}
		saveLabel={t('save')}
		saveDisabled={saving || !name.trim()}
		onsave={() => formEl?.requestSubmit()}
		onclose={() => (panel = null)}
		{dirty}
		discard={{
			title: t('discard_title'),
			description: t('discard_hint'),
			keep: t('discard_keep'),
			discard: t('discard_confirm'),
		}}
	>
		{#snippet danger()}
			{#if editing}
				<ConfirmButton
					label={t('members_remove')}
					confirmLabel={t('members_remove_confirm')}
					onconfirm={() => remove(editing)}
				/>
			{/if}
		{/snippet}
		<form class="grid gap-4" bind:this={formEl} onsubmit={submit}>
			<div class="grid gap-1.5">
				<Label for="member-name">{t('members_name')}</Label>
				<Input id="member-name" bind:value={name} required maxlength={60} />
			</div>
			<div class="grid gap-1.5">
				<Label for="member-role">{t('members_role')}</Label>
				<SelectField id="member-role" bind:value={roleId}>
					{#each roles.filter((r) => r.builtIn) as r (r.id)}
						<option value={r.id}>{roleName(r.id)}</option>
					{/each}
					{#each roles.filter((r) => !r.builtIn) as r (r.id)}
						<option value={r.id}>{r.name}</option>
					{/each}
				</SelectField>
				<small class="text-ink-soft text-[13px]">{roleHint(roleId)}</small>
			</div>
			<div class="grid gap-1.5">
				<Label for="member-about">{t('members_about')}</Label>
				<Input id="member-about" bind:value={about} maxlength={300} />
				<small class="text-ink-soft text-[13px]">{t('members_about_hint')}</small>
			</div>

			<div class="border-line grid gap-4 border-t pt-4" data-testid="member-signin">
				<div class="grid gap-1">
					<h3 class="text-ink-soft text-xs font-bold tracking-[0.06em] uppercase">
						{t('members_signin_title')}
					</h3>
					<p class="text-ink-soft text-[13px]">{t('members_signin_intro')}</p>
					{#if editing && signIn(editing)}
						<p class="text-[13px] font-semibold">
							{t('members_signin_now', { how: signIn(editing) })}
						</p>
					{/if}
				</div>
				<div class="grid gap-1.5">
					<Label for="member-email">{t('members_email')}</Label>
					<Input
						id="member-email"
						type="email"
						bind:value={email}
						autocomplete="off"
						required={password !== ''}
					/>
				</div>
				<div class="grid gap-1.5">
					<Label for="member-password">{t('members_password')}</Label>
					<Input
						id="member-password"
						type="password"
						bind:value={password}
						minlength={10}
						autocomplete="new-password"
						required={email !== ''}
					/>
				</div>
				{#if mayUsePin(roleId)}
					<div class="grid gap-1.5">
						<Label for="member-pin"
							>{editing?.signIn?.pin ? t('members_new_pin') : t('members_pin_label')}</Label
						>
						<Input
							id="member-pin"
							inputmode="numeric"
							autocomplete="off"
							pattern={'\\d{4,6}'}
							bind:value={pin}
						/>
						<small class="text-ink-soft text-[13px]">
							{t('members_pin_hint')}
							{#if holds(roleId, ADMINISTERS)}{t('members_pin_admin_hint')}{/if}
						</small>
					</div>
				{:else}
					<p class="text-ink-soft text-[13px]">{t('members_pin_role_off')}</p>
				{/if}
				<small class="text-ink-soft text-[13px]"
					>{editing ? t('members_signin_leave') : t('members_signin_later')}</small
				>
			</div>
			{#if editing}
				<p class="text-ink-soft text-[13px]">{t('members_remove_hint')}</p>
			{/if}
			{#if error}<p class="text-destructive text-sm font-semibold" role="alert">{error}</p>{/if}
		</form>
	</SidePanel>
</Page>
