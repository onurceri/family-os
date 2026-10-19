<script lang="ts">
	import { isApiError } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import { Avatar, Card, ConfirmButton, Row, Section, SidePanel } from '@famos/ui/famos';
	import { onDestroy, onMount } from 'svelte';
	import type {
		NotifyStatus,
		NotifyTargets,
		PersonLink,
		Persons,
		SharingLevel,
	} from '../contract/index.js';
	import {
		linkPerson,
		loadLinks,
		loadNotifyTargets,
		loadPersons,
		setNotifyTarget,
		testNotify,
		unlinkPerson,
	} from './data.js';
	import { useHomeAssistant } from './i18n.js';

	/**
	 * Settings, Home Assistant, "People": which Home Assistant person each member is. Tap a member
	 * to choose their person, or to unlink them. What a person shows is theirs to choose (Settings
	 * → You): here it is only read, never changed. A linked member also gets the phone their texts
	 * go to in the Home Assistant app, with a test; members turn those texts on themselves under
	 * Settings → Notifications.
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
		off = app.onEvent('homeassistant.people', () => {
			void load().then(settleTest);
		});
	});
	onDestroy(() => {
		off?.();
		clearTimeout(testTimer);
	});

	const members = $derived(app.members());
	const linkOf = (memberId: string) => links.find((l) => l.memberId === memberId);
	const nameOf = (entityId: string) =>
		persons?.persons.find((p) => p.entityId === entityId)?.name ?? entityId;

	const SHARES = {
		none: 'people_shares_none',
		home: 'people_shares_home',
		place: 'people_shares_place',
	} as const satisfies Record<SharingLevel, string>;

	const STATUS_WORDS = {
		ok: 'notify_status_ok',
		missing: 'notify_status_missing',
		refused: 'notify_status_refused',
		unreachable: 'notify_status_unreachable',
	} as const satisfies Record<NotifyStatus, string>;

	/** The person they are, what they chose to show, and where their texts go. */
	function meta(memberId: string): string {
		const link = linkOf(memberId);
		if (!link) return t('people_not_linked');
		const shares = t(SHARES[link.level]);
		const phoneName = link.notifyService ?? t('notify_none');
		// A phone that is gone is worth seeing without opening the row.
		const trouble = link.notifyStatus === 'missing' ? t(STATUS_WORDS.missing) : '';
		return [
			nameOf(link.personEntity),
			shares,
			link.onDisplays ? t('people_on_displays') : '',
			t('notify_summary', { phone: phoneName }),
			trouble,
		]
			.filter(Boolean)
			.join(' · ');
	}

	// Choosing a member's person
	let editing = $state<{ id: string; displayName: string } | null>(null);
	let chosen = $state<string | null>(null);
	let busy = $state(false);
	let failed = $state<'people_error' | 'people_taken' | null>(null);

	// The phone for texts
	let targets = $state<NotifyTargets | null>(null);
	let phone = $state<string | null>(null);
	let testing = $state(false);
	let testTimer: ReturnType<typeof setTimeout> | undefined;

	function open(member: { id: string; displayName: string }) {
		editing = member;
		const link = linkOf(member.id);
		chosen = link?.personEntity ?? null;
		phone = link?.notifyService ?? null;
		targets = null;
		testing = false;
		failed = null;
		if (link) void findTargets(member.id);
	}

	async function findTargets(memberId: string) {
		try {
			const found = await loadNotifyTargets(memberId);
			if (editing?.id === memberId) targets = found;
		} catch {
			if (editing?.id === memberId) targets = { targets: [], status: 'unavailable' };
		}
	}

	/** The saved link of the member in the panel, when what is chosen is that very person. */
	const savedLink = $derived.by(() => {
		const link = editing ? linkOf(editing.id) : undefined;
		return link && link.personEntity === chosen ? link : undefined;
	});
	const phoneChanged = $derived(savedLink !== undefined && phone !== savedLink.notifyService);
	const personChanged = $derived(
		editing !== null && chosen !== (linkOf(editing.id)?.personEntity ?? null),
	);

	/** The phones to choose from; a phone chosen earlier that Home Assistant no longer lists stays visible. */
	const phones = $derived.by(() => {
		const listed = targets?.targets ?? [];
		const kept = savedLink?.notifyService;
		return kept && !listed.some((x) => x.service === kept)
			? [{ service: kept, suggested: false }, ...listed]
			: listed;
	});

	const testable = $derived(savedLink?.notifyService != null && !phoneChanged && !testing);
	const outcome = $derived(
		testing
			? ('notify_testing' as const)
			: savedLink?.notifyStatus
				? STATUS_WORDS[savedLink.notifyStatus]
				: null,
	);

	async function sendTest() {
		if (!editing) return;
		testing = true;
		// The answer comes as an event; if it never does, the line stops waiting.
		clearTimeout(testTimer);
		testTimer = setTimeout(() => (testing = false), 20_000);
		try {
			await testNotify(editing.id);
			await load();
			settleTest();
		} catch {
			testing = false;
			failed = 'people_error';
		}
	}

	/** A test is over when its row has an answer. */
	function settleTest() {
		if (testing && editing && linkOf(editing.id)?.notifyStatus) {
			testing = false;
			clearTimeout(testTimer);
		}
	}

	/** Whose person this is already, when it is someone else's. */
	const takenBy = (entityId: string) => {
		const other = links.find((l) => l.personEntity === entityId && l.memberId !== editing?.id);
		return other ? members.find((m) => m.id === other.memberId)?.displayName : undefined;
	};

	async function save() {
		if (!editing) return;
		const current = linkOf(editing.id)?.personEntity ?? null;
		if (!chosen || (chosen === current && !phoneChanged)) {
			editing = null;
			return;
		}
		busy = true;
		failed = null;
		try {
			if (chosen !== current) {
				await linkPerson({ memberId: editing.id, personEntity: chosen });
				app.toast(t('people_linked'));
			} else {
				await setNotifyTarget({ memberId: editing.id, service: phone });
				app.toast(t('show_saved'));
			}
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
	<p class="text-ink-soft max-w-prose text-[13px]">{t('notify_privacy')}</p>
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
	dirty={personChanged || phoneChanged}
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
		{#if savedLink}
			<Section label={t('notify_label')} level={3}>
				<p class="text-ink-soft text-sm">{t('notify_hint')}</p>
				{#if targets === null}
					<!-- The phones are on their way; the rest of the panel is already usable. -->
				{:else if targets.status === 'unavailable'}
					<p class="text-ink-soft text-sm">{t('notify_unavailable')}</p>
				{:else if phones.length === 0}
					<p class="text-ink-soft text-sm">{t('notify_no_targets')}</p>
				{:else}
					<Card rows>
						{#each phones as option (option.service)}
							<Row
								title={option.service}
								meta={option.suggested ? t('notify_suggested') : undefined}
								selected={phone === option.service}
								onclick={() => (phone = option.service)}
							/>
						{/each}
						<Row
							title={t('notify_none_option')}
							selected={phone === null}
							onclick={() => (phone = null)}
						/>
					</Card>
				{/if}
				<div class="flex flex-wrap items-center gap-3">
					<Button variant="outline" disabled={!testable} onclick={() => void sendTest()}
						>{t('notify_test')}</Button
					>
					{#if phoneChanged}
						<span class="text-ink-soft text-sm">{t('notify_test_save_first')}</span>
					{:else if outcome}
						<span
							class="text-sm {outcome === 'notify_status_ok' || outcome === 'notify_testing'
								? 'text-ink-soft'
								: 'text-attention font-semibold'}"
							role="status">{t(outcome)}</span
						>
					{/if}
				</div>
			</Section>
		{/if}
		{#if failed}
			<p class="text-attention text-sm font-semibold" role="alert">{t(failed)}</p>
		{/if}
	</div>
</SidePanel>
