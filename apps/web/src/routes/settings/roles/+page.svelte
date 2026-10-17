<script lang="ts">
	import { type paths, unwrap } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import {
		Card,
		Chip,
		ConfirmButton,
		IconButton,
		Page,
		PageHeader,
		Section,
		Segmented,
		SidePanel,
		SwitchRow,
		wide,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { Check, ChevronRight, Lock, Minus, Pencil, Plus } from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { api } from '#lib/api.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import { onEvent } from '#lib/realtime.js';
	import { session } from '#lib/session.svelte.js';

	/**
	 * Roles: on wide windows a table of every role with a sticky
	 * head and folded groups; on phones one role at a time with a switch for each thing. Creating
	 * and changing your own roles happens in a panel (a sheet on phones).
	 */
	type Data = paths['/api/v1/core/roles']['get']['responses'][200]['content']['application/json'];
	type Role = Data['roles'][number];
	type Base = 'member' | 'supervised' | 'guest';

	let data = $state<Data | null>(null);
	/** The role being created or edited: name, base, and the capabilities it should have. */
	let editing = $state<{
		id: string | null;
		name: string;
		base: Base;
		granted: Set<string>;
		/** What the panel started with, to know whether anything changed. */
		start: string;
	} | null>(null);
	let error = $state<string | null>(null);
	let formEl = $state<HTMLFormElement>();
	/** The role the phone shows. */
	let shownRole = $state<string | null>(null);

	async function load() {
		data = (await api.GET('/api/v1/core/roles')).data ?? null;
	}
	$effect(() => {
		if (!session.can('core.roles.manage')) return;
		void load();
		return onEvent('core.role.', () => void load());
	});

	const roleName = (role: Role) => role.name ?? tDynamic(`app:role_${role.id}`);
	const builtIn = (id: string) => data?.roles.find((r) => r.id === id);
	const phoneRole = $derived(data?.roles.find((r) => r.id === shownRole) ?? data?.roles[0]);
	/** Capabilities grouped by the extension (or core) that declared them, in registry order. */
	const groups = $derived.by(() => {
		const out = new Map<string, Data['capabilities']>();
		for (const c of data?.capabilities ?? []) out.set(c.owner, [...(out.get(c.owner) ?? []), c]);
		return [...out];
	});
	const ownerName = (owner: string) =>
		owner === 'core' ? t('roles_group_core') : tDynamic(`${owner}:feature_name`);
	// The table is long, so the parts start folded except the family-wide one.
	const open = new SvelteSet<string>(['core']);
	const allOpen = $derived(groups.every(([owner]) => open.has(owner)));
	function toggleAll() {
		if (allOpen) open.clear();
		else for (const [owner] of groups) open.add(owner);
	}

	const snapshot = (name: string, granted: Set<string>) =>
		`${name}|${[...granted].toSorted().join(',')}`;
	const dirty = $derived(
		editing !== null && snapshot(editing.name, editing.granted) !== editing.start,
	);

	function derive(base: Base) {
		const granted = new Set(builtIn(base)?.capabilities ?? []);
		editing = { id: null, name: '', base, granted, start: snapshot('', granted) };
		error = null;
	}
	function edit(role: Role) {
		const granted = new Set(role.capabilities);
		editing = {
			id: role.id,
			name: role.name ?? '',
			base: role.base as Base,
			granted,
			start: snapshot(role.name ?? '', granted),
		};
		error = null;
	}
	function toggle(id: string) {
		if (!editing) return;
		const next = new Set(editing.granted);
		next.has(id) ? next.delete(id) : next.add(id);
		editing.granted = next;
	}

	/** Overrides are the differences from the base role, so later capabilities follow the base. */
	function overrides(base: Base, granted: Set<string>): Record<string, boolean> {
		const defaults = new Set(builtIn(base)?.capabilities ?? []);
		const out: Record<string, boolean> = {};
		for (const c of data?.capabilities ?? []) {
			if (c.critical) continue;
			if (granted.has(c.id) !== defaults.has(c.id)) out[c.id] = granted.has(c.id);
		}
		return out;
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		const e = editing;
		if (!e) return;
		error = null;
		try {
			const changes = overrides(e.base, e.granted);
			if (e.id) {
				unwrap(
					await api.POST('/api/v1/actions/core.updateRole', {
						body: { id: e.id, name: e.name, overrides: changes },
					}),
				);
			} else {
				unwrap(
					await api.POST('/api/v1/actions/core.createRole', {
						body: { name: e.name, base: e.base, overrides: changes },
					}),
				);
			}
			editing = null;
			await load();
		} catch {
			error = t('error_generic');
		}
	}

	/** On phones a switch of your own role is saved as soon as it is flipped. */
	async function flip(role: Role, capabilityId: string) {
		error = null;
		const granted = new Set(role.capabilities);
		granted.has(capabilityId) ? granted.delete(capabilityId) : granted.add(capabilityId);
		try {
			unwrap(
				await api.POST('/api/v1/actions/core.updateRole', {
					body: {
						id: role.id,
						name: role.name ?? '',
						overrides: overrides(role.base as Base, granted),
					},
				}),
			);
			await load();
		} catch {
			error = t('error_generic');
		}
	}

	async function remove(id: string) {
		error = null;
		try {
			unwrap(await api.POST('/api/v1/actions/core.deleteRole', { body: { id } }));
			editing = null;
			await load();
		} catch {
			error = t('roles_in_use');
		}
	}

	const baseOptions = $derived(
		(['member', 'supervised', 'guest'] as const).map((base) => ({
			value: base,
			label: tDynamic(`app:role_${base}`),
		})),
	);
</script>

<Page template="settings">
	<PageHeader title={t('roles_title')} subtitle={t('roles_intro')}>
		{#snippet actions()}
			{#if data}
				{#if wide.current}
					<Button variant="ghost" onclick={toggleAll}
						>{allOpen ? t('roles_collapse_all') : t('roles_expand_all')}</Button
					>
					<Button variant="primary" onclick={() => derive('member')}
						><Plus aria-hidden="true" />{t('roles_new')}</Button
					>
				{:else}
					<IconButton variant="primary" label={t('roles_new')} onclick={() => derive('member')}>
						<Plus class="size-5" aria-hidden="true" />
					</IconButton>
				{/if}
			{/if}
		{/snippet}
	</PageHeader>

	{#if data}
		{#if wide.current}
			<div class="grid gap-3">
				<Card class="overflow-clip">
					<table class="w-full text-sm" aria-label={t('roles_title')}>
						<thead class="bg-surface sticky top-0 z-10 shadow-[0_1px_0_var(--line)]">
							<tr class="text-left">
								<th class="text-ink-soft px-4 py-3 text-xs font-bold tracking-[0.06em] uppercase"
									>{t('roles_capability')}</th
								>
								{#each data.roles as role (role.id)}
									<th class="px-3 py-3 text-center font-bold">
										{#if role.builtIn}
											{roleName(role)}
										{:else}
											<button
												type="button"
												class="inline-flex items-center gap-1 underline-offset-4 hover:underline"
												aria-label={t('roles_edit_role', { name: roleName(role) })}
												onclick={() => edit(role)}
												>{roleName(role)}<Pencil class="size-3.5" aria-hidden="true" /></button
											>
										{/if}
										<small class="text-ink-soft block font-normal"
											>{t('roles_people', { count: role.members })}</small
										>
									</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each groups as [owner, capabilities] (owner)}
								{@const shown = open.has(owner)}
								<tr class="bg-idle border-line border-t">
									<th colspan={data.roles.length + 1} class="p-0 text-left">
										<button
											type="button"
											aria-expanded={shown}
											onclick={() => (shown ? open.delete(owner) : open.add(owner))}
											class="text-ink-soft hover:text-ink flex min-h-10 w-full items-center gap-2 px-4 text-xs font-bold tracking-[0.06em] uppercase outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--info)]"
										>
											<ChevronRight
												class="size-4 shrink-0 transition-transform {shown ? 'rotate-90' : ''}"
												aria-hidden="true"
											/>{ownerName(owner)}
											<span class="font-normal tracking-normal normal-case"
												>· {t('roles_n_things', { count: capabilities.length })}</span
											>
										</button>
									</th>
								</tr>
								{#each shown ? capabilities : [] as capability (capability.id)}
									<tr class="border-line border-t">
										<td class="px-4 py-2.5">
											<span class="inline-flex items-center gap-1.5">
												{tDynamic(capability.label)}
												{#if capability.critical}<Lock
														class="text-ink-soft size-3.5"
														aria-label={t('roles_critical')}
													/>{/if}
											</span>
										</td>
										{#each data.roles as role (role.id)}
											<td class="px-3 py-2.5 text-center">
												{#if role.capabilities.includes(capability.id)}
													<Check class="text-now mx-auto size-4" aria-label={t('roles_yes')} />
												{:else}
													<Minus
														class="text-ink-soft/50 mx-auto size-4"
														aria-label={t('roles_no')}
													/>
												{/if}
											</td>
										{/each}
									</tr>
								{/each}
							{/each}
						</tbody>
					</table>
				</Card>
				<p class="text-ink-soft flex items-center gap-1.5 px-1 text-[13px]">
					<Lock class="size-3.5" aria-hidden="true" />{t('roles_critical_hint')}
				</p>
				<p class="text-ink-soft max-w-prose px-1 text-[13px]">{t('roles_custom_intro')}</p>
			</div>
		{:else if phoneRole}
			{@const role = phoneRole}
			<div class="grid gap-5">
				<div
					class="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1"
					role="group"
					aria-label={t('roles_title')}
				>
					{#each data.roles as r (r.id)}
						<Chip on={r.id === role.id} onclick={() => (shownRole = r.id)}>{roleName(r)}</Chip>
					{/each}
				</div>
				<div class="flex items-center gap-3 px-1">
					<p class="text-ink-soft min-w-0 flex-1 text-[13px]">
						{role.builtIn
							? tDynamic(`app:role_${role.id}_hint`)
							: t('role_custom_hint', { base: tDynamic(`app:role_${role.base}`) })} · {t(
							'roles_people',
							{
								count: role.members,
							},
						)}
					</p>
					{#if !role.builtIn}
						<Button variant="ghost" size="sm" onclick={() => edit(role)}
							><Pencil class="size-4" aria-hidden="true" />{t('members_edit')}</Button
						>
					{/if}
				</div>
				{#each groups as [owner, capabilities] (owner)}
					{@const shown = open.has(owner)}
					<Section
						label={ownerName(owner)}
						count={t('roles_n_things', { count: capabilities.length })}
					>
						{#snippet actions()}
							<Button
								variant="ghost"
								size="sm"
								aria-expanded={shown}
								onclick={() => (shown ? open.delete(owner) : open.add(owner))}
								>{shown ? t('roles_fold') : t('roles_open')}</Button
							>
						{/snippet}
						{#if shown}
							<Card rows>
								{#each capabilities as capability (capability.id)}
									<SwitchRow
										id="cap-{role.id}-{capability.id}"
										label={tDynamic(capability.label)}
										hint={capability.critical ? t('roles_critical') : undefined}
										checked={role.capabilities.includes(capability.id)}
										disabled={role.builtIn || capability.critical}
										onchange={() => flip(role, capability.id)}
									/>
								{/each}
							</Card>
						{/if}
					</Section>
				{/each}
				<p class="text-ink-soft flex items-center gap-1.5 px-1 text-[13px]">
					<Lock class="size-3.5" aria-hidden="true" />{t('roles_critical_hint')}
				</p>
			</div>
		{/if}
		{#if error && editing === null}<p
				class="text-attention pt-3 text-sm font-semibold"
				role="alert"
			>
				{error}
			</p>{/if}
	{/if}

	<SidePanel
		open={editing !== null}
		title={editing?.id ? t('roles_edit_role', { name: editing.name }) : t('roles_new')}
		closeLabel={t('side_panel_close')}
		cancelLabel={t('cancel')}
		saveLabel={editing?.id ? t('roles_save') : t('roles_create')}
		saveDisabled={!editing?.name.trim()}
		onsave={() => formEl?.requestSubmit()}
		onclose={() => (editing = null)}
		{dirty}
		discard={{
			title: t('discard_title'),
			description: t('discard_hint'),
			keep: t('discard_keep'),
			discard: t('discard_confirm'),
		}}
	>
		{#snippet danger()}
			{#if editing?.id}
				{@const id = editing.id}
				<ConfirmButton
					label={t('roles_delete')}
					confirmLabel={t('roles_delete_confirm')}
					onconfirm={() => remove(id)}
				/>
			{/if}
		{/snippet}
		{#if editing}
			<form class="grid gap-5" bind:this={formEl} onsubmit={save}>
				<div class="grid gap-1.5">
					<Label for="role-name">{t('roles_name')}</Label>
					<Input id="role-name" bind:value={editing.name} required maxlength={40} />
				</div>
				{#if editing.id === null}
					<div class="grid gap-1.5">
						<span class="text-sm font-semibold">{t('roles_start_from')}</span>
						<Segmented
							grow
							label={t('roles_start_from')}
							options={baseOptions}
							value={editing.base}
							onchange={(base) => {
								const typed = editing?.name ?? '';
								derive(base as Base);
								if (editing) editing.name = typed;
							}}
						/>
						<small class="text-ink-soft text-[13px]">{t('roles_custom_intro')}</small>
					</div>
				{:else}
					<small class="text-ink-soft text-[13px]"
						>{t('roles_based_on', { base: tDynamic(`app:role_${editing.base}`) })}</small
					>
				{/if}
				{#each groups as [owner, capabilities] (owner)}
					{@const things = capabilities.filter((c) => !c.critical)}
					{#if things.length > 0}
						<Section label={ownerName(owner)} level={3}>
							<Card rows>
								{#each things as capability (capability.id)}
									<SwitchRow
										id="edit-{capability.id}"
										label={tDynamic(capability.label)}
										checked={editing.granted.has(capability.id)}
										onchange={() => toggle(capability.id)}
									/>
								{/each}
							</Card>
						</Section>
					{/if}
				{/each}
				{#if error}<p class="text-attention text-sm font-semibold" role="alert">{error}</p>{/if}
			</form>
		{/if}
	</SidePanel>
</Page>
