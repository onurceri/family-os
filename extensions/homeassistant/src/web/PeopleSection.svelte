<script lang="ts">
	import { isApiError } from '@famos/api-client';
	import { Avatar, Card, ConfirmButton, Row, Section, SidePanel } from '@famos/ui/famos';
	import { onDestroy, onMount } from 'svelte';
	import type { PersonLink, Persons, SharingLevel } from '../contract/index.js';
	import { linkPerson, loadLinks, loadPersons, unlinkPerson } from './data.js';
	import { useHomeAssistant } from './i18n.js';

	/**
	 * Settings, Home Assistant, "People": which Home Assistant person each member is. Tap a member
	 * to choose their person, or to unlink them. What a person shows is theirs to choose (Settings
	 * → You): here it is only read, never changed.
	 */
	const { app, t } = useHomeAssistant();

	let links = $state<PersonLink[]>([]);
	let persons = $state<Persons | null>(null);

	async function load() {
		try {
			[links, persons] = await Promise.all([loadLinks(), loadPersons()]);
		} catch {
			// Keep what is shown; an event or the next visit loads it again.
		}
	}
	let off: (() => void) | undefined;
	onMount(() => {
		void load();
		off = app.onEvent('homeassistant.people', () => void load());
	});
	onDestroy(() => off?.());

	const members = $derived(app.members());
	const linkOf = (memberId: string) => links.find((l) => l.memberId === memberId);
	const nameOf = (entityId: string) =>
		persons?.persons.find((p) => p.entityId === entityId)?.name ?? entityId;

	const SHARES = {
		none: 'people_shares_none',
		home: 'people_shares_home',
		place: 'people_shares_place',
	} as const satisfies Record<SharingLevel, string>;

	/** The person they are, and what they chose to show. */
	function meta(memberId: string): string {
		const link = linkOf(memberId);
		if (!link) return t('people_not_linked');
		const shares = t(SHARES[link.level]);
		return [nameOf(link.personEntity), shares, link.onDisplays ? t('people_on_displays') : '']
			.filter(Boolean)
			.join(' · ');
	}

	// Choosing a member's person
	let editing = $state<{ id: string; displayName: string } | null>(null);
	let chosen = $state<string | null>(null);
	let busy = $state(false);
	let failed = $state<'people_error' | 'people_taken' | null>(null);

	function open(member: { id: string; displayName: string }) {
		editing = member;
		chosen = linkOf(member.id)?.personEntity ?? null;
		failed = null;
	}

	/** Whose person this is already, when it is someone else's. */
	const takenBy = (entityId: string) => {
		const other = links.find((l) => l.personEntity === entityId && l.memberId !== editing?.id);
		return other ? members.find((m) => m.id === other.memberId)?.displayName : undefined;
	};

	async function save() {
		if (!editing) return;
		const current = linkOf(editing.id)?.personEntity ?? null;
		if (!chosen || chosen === current) {
			editing = null;
			return;
		}
		busy = true;
		failed = null;
		try {
			await linkPerson({ memberId: editing.id, personEntity: chosen });
			app.toast(t('people_linked'));
			editing = null;
			await load();
		} catch (error) {
			failed = isApiError(error) && error.code === 'conflict' ? 'people_taken' : 'people_error';
		} finally {
			busy = false;
		}
	}

	async function unlink() {
		if (!editing) return;
		try {
			await unlinkPerson(editing.id);
			app.toast(t('people_unlinked'));
			editing = null;
			await load();
		} catch {
			failed = 'people_error';
		}
	}

	const discard = $derived({
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	});
</script>

<Section label={t('people_label')}>
	<Card rows>
		{#each members as member (member.id)}
			<Row title={member.displayName} meta={meta(member.id)} onclick={() => open(member)}>
				{#snippet lead()}<Avatar
						name={member.displayName}
						color={member.color}
						size={32}
					/>{/snippet}
			</Row>
		{/each}
	</Card>
	<p class="text-ink-soft max-w-prose text-[13px]">{t('people_choice_line')}</p>
</Section>

<SidePanel
	open={editing !== null}
	title={editing ? t('people_link_title', { name: editing.displayName }) : ''}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={t('show_save')}
	saveDisabled={busy}
	onsave={() => void save()}
	onclose={() => (editing = null)}
	dirty={editing !== null && chosen !== (linkOf(editing.id)?.personEntity ?? null)}
	{discard}
>
	{#snippet danger()}
		{#if editing && linkOf(editing.id)}
			<ConfirmButton
				label={t('people_unlink')}
				confirmLabel={t('people_unlink_confirm')}
				onconfirm={unlink}
			/>
		{/if}
	{/snippet}
	<div class="grid gap-4">
		<p class="text-ink-soft text-sm">{t('people_link_hint')}</p>
		{#if persons?.status === 'ok' && persons.persons.length === 0}
			<p class="text-ink-soft text-sm">{t('people_none_found')}</p>
		{:else if persons && persons.status !== 'ok'}
			<p class="text-ink-soft text-sm">{t('show_unavailable')}</p>
		{:else if persons}
			<Card rows>
				{#each persons.persons as person (person.entityId)}
					{@const other = takenBy(person.entityId)}
					<Row
						title={person.name}
						meta={other ? t('people_linked_to', { name: other }) : undefined}
						selected={chosen === person.entityId}
						onclick={other ? undefined : () => (chosen = person.entityId)}
					/>
				{/each}
			</Card>
		{/if}
		{#if failed}
			<p class="text-attention text-sm font-semibold" role="alert">{t(failed)}</p>
		{/if}
	</div>
</SidePanel>
