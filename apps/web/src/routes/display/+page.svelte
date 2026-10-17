<script lang="ts">
	import { dateLocale, formatTime } from '@famos/time';
	import { provideAppContext } from '@famos/ui/app';
	import { trackWork } from '@famos/ui/famos';
	import type { SlotContribution } from '@famos/ui/slots';
	import { api } from '#lib/api.js';
	import { appearance } from '#lib/appearance.svelte.js';
	import { browserFormatLocale } from '#lib/family.svelte.js';
	import { contributions, enabledOnly } from '#lib/extensions.js';
	import { getLocale, loadLanguages, setLocale, t, tDynamic } from '#lib/i18n.svelte.js';
	import { connectRealtime, onEvent } from '#lib/realtime.js';
	import { onExtensionsChanged } from '#lib/server-changes.js';
	import { familyModeCapabilities } from '#lib/today/today-data.svelte.js';
	import FamilyToday from './FamilyToday.svelte';
	import PairScreen from './PairScreen.svelte';

	/**
	 * The family display. Nobody signs in here: an unpaired browser asks for
	 * a pairing code; a paired one shows Today in family mode, in the display's style: no person,
	 * nothing to act on, only what an admin allowed at pairing. The display's status pills sit in
	 * the head, the `display.widget` tiles in a band at the foot, and ambient mode covers it all
	 * after a while idle. It depends on nothing a signed-in member has (`/core/me`, family
	 * settings).
	 */
	type Me = {
		name: string;
		capabilities: string[];
		showNames: boolean;
		timeZone: string;
		locale: string;
		formatLocale: string;
		weekStart: number;
		hourCycle: 'h12' | 'h23';
		temperatureUnit: 'celsius' | 'fahrenheit';
		disabledExtensions: string[];
		theme: string | null;
		/** The blocks this display's Today hides. */
		hidden: string[];
	};
	type Member = { id: string; displayName: string; color: string };

	/** `signedIn`: the family uses this browser (a member's session, or a trusted family device). */
	let phase = $state<'loading' | 'unpaired' | 'paired' | 'signedIn'>('loading');
	let me = $state<Me | null>(null);
	let members = $state<Member[]>([]);
	/** The members are in (or not shown): only then does Today start, so it reads once. */
	let membersLoaded = $state(false);
	let unreachable = $state(false);
	let now = $state(new Date());
	/** Bumped every few minutes: Today reads again and the widgets reload from scratch. */
	let refreshKey = $state(0);
	/** Bumped to remount the pairing screen: a consumed code is useless, a fresh one is needed. */
	let pairKey = $state(0);
	/** The pairing screen reported "paired" and the first `check()` after it has not finished. */
	let justPaired = false;

	/** Dates and times on the display: its language's words, the family's region and clock. */
	const shownDateLocale = () =>
		dateLocale(getLocale(), me?.formatLocale ?? browserFormatLocale(), me?.hourCycle ?? 'h23');

	// What widgets (written for the app) may use; the display has no member, no toasts, no drafts.
	provideAppContext({
		t: (key, options) => tDynamic(key, options),
		locale: () => getLocale(),
		formatLocale: () => me?.formatLocale ?? browserFormatLocale(),
		dateLocale: shownDateLocale,
		weekStart: () => me?.weekStart ?? 1,
		hourCycle: () => me?.hourCycle ?? 'h23',
		temperatureUnit: () => me?.temperatureUnit ?? 'celsius',
		members: () => members,
		me: () => null,
		can: (capability) => me?.capabilities.includes(capability) ?? false,
		// A display only looks: it never changes or suggests anything.
		access: () => 'no',
		accessFor: () => 'no',
		approval: () => undefined,
		timeZone: () => me?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
		onEvent,
		draftPresenter: () => undefined,
		slots: () => [],
		isAppPath: () => false,
		share: () => undefined,
		toast: () => {},
		sentForApproval: () => {},
		awaitsApproval: () => false,
		awaitedChange: () => undefined,
		// A display only looks: no actions, no offline queue.
		runAction: () => Promise.reject(new Error('Displays cannot run actions')),
		waiting: () => [],
		offline: () => false,
		query: () => new URLSearchParams(),
		setQuery: () => {},
	});

	async function check() {
		try {
			const res = await api.GET('/api/v1/core/displays/me');
			if (res.data) {
				const first = me === null;
				me = res.data;
				phase = 'paired';
				unreachable = false;
				justPaired = false;
				if (first || getLocale() !== res.data.locale) {
					// The display speaks the family's language (never a member's).
					await loadLanguages();
					await setLocale(res.data.locale);
				}
				// The display's own theme and style, else the family's; it keeps
				// following the sun.
				appearance.applyStyle(res.data.style);
				void appearance.apply(res.data.theme);
				await loadMembers();
			} else if (res.response.status === 409) {
				me = null;
				members = [];
				membersLoaded = false;
				phase = 'signedIn';
				unreachable = false;
			} else if (res.response.status === 401) {
				// Never paired, or revoked: back to the pairing screen.
				me = null;
				members = [];
				membersLoaded = false;
				phase = 'unpaired';
				unreachable = false;
				// The screen that just paired has stopped polling and holds a used-up code.
				if (justPaired) restartPairing();
			} else {
				unreachable = true;
				if (justPaired) restartPairing();
			}
		} catch {
			unreachable = true;
			if (justPaired) restartPairing();
		}
	}

	function restartPairing() {
		justPaired = false;
		phase = 'unpaired';
		pairKey++;
	}

	async function loadMembers() {
		if (!me?.showNames) {
			members = [];
			membersLoaded = true;
			return;
		}
		const res = await api.GET('/api/v1/core/members');
		const next = (res.data ?? []).map((m) => ({
			id: m.id,
			displayName: m.displayName,
			color: m.color,
		}));
		// The same members keep the same array, so nothing that reads them runs again.
		if (JSON.stringify(next) !== JSON.stringify(members)) members = next;
		membersLoaded = true;
	}

	$effect(() => {
		void check();
	});

	// Signing out or forgetting the device in another tab turns this into a pairing screen.
	$effect(() => {
		if (phase !== 'signedIn') return;
		const recheck = setInterval(() => void check(), 10_000);
		return () => clearInterval(recheck);
	});

	// Live updates and housekeeping while paired.
	$effect(() => {
		if (phase !== 'paired') return;
		const disconnect = connectRealtime();
		const offDevice = onEvent('core.device.', () => void check());
		const offMembers = onEvent('core.member.', () => void loadMembers());
		const offFeatures = onEvent('core.features.', () => void check());
		// The server restarted with other extensions: nobody types on a display, so it reloads.
		const offChanged = onExtensionsChanged(() => location.reload());
		// A theme was installed, changed or chosen for this display.
		const offThemes = onEvent('core.themes.', () => void check());
		// Family language, region formats or time zone changed, or a language pack was updated.
		const offFamily = onEvent('core.family.', () => void check());
		const offLanguages = onEvent('core.languages.', () =>
			loadLanguages().then(() => setLocale(getLocale(), { force: true })),
		);
		const clock = setInterval(() => (now = new Date()), 1000);
		// Revoking or changing this display shows up within a minute even if an event was missed;
		// Today and the widgets read again every five minutes as a safety net for missed events.
		let ticks = 0;
		const housekeeping = setInterval(() => {
			void check();
			if (++ticks % 5 === 0) refreshKey++;
		}, 60_000);
		return () => {
			disconnect();
			offDevice();
			offMembers();
			offFeatures();
			offChanged();
			offThemes();
			offFamily();
			offLanguages();
			clearInterval(clock);
			clearInterval(housekeeping);
		};
	});

	/** The contributions of a display slot this display may show, in `order`. */
	function visible<S extends 'display.widget' | 'display.status'>(slot: S) {
		const held = me?.capabilities ?? [];
		return enabledOnly(
			contributions.slots.filter((c) => c.slot === slot),
			me?.disabledExtensions ?? [],
		)
			.filter((c) => !c.requires || held.includes(c.requires))
			.toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0)) as SlotContribution<S>[];
	}
	const widgets = $derived(visible('display.widget'));

	/**
	 * What the screen had no room for, told to the server so Settings → Devices can say it. Sent
	 * when it changes, and again with every refresh (the server keeps it in memory only).
	 */
	let reported: string | null = null;
	$effect(() => {
		void refreshKey;
		reported = null;
	});
	function reportFit(leftOut: string[]) {
		const said = JSON.stringify(leftOut);
		if (said === reported) return;
		reported = said;
		void api
			.GET('/api/v1/core/displays/me/fit', { params: { query: { leftOut: leftOut.join(',') } } })
			.catch(() => {
				// Not said this time; the next fit or refresh says it again.
				reported = null;
			});
	}
	const statuses = $derived(visible('display.status'));
	/** Nothing granted that the display could show: it says where to choose. */
	const empty = $derived(
		widgets.length === 0 &&
			statuses.length === 0 &&
			!familyModeCapabilities().some((c) => me?.capabilities.includes(c)),
	);

	const ambient = $derived(
		enabledOnly(
			contributions.slots.filter((c) => c.slot === 'display.ambient'),
			me?.disabledExtensions ?? [],
		) as SlotContribution<'display.ambient'>[],
	);

	const zone = $derived(me?.timeZone);
	// Written the family's way (date locale and hour cycle), the same as Today's times.
	const time = $derived(
		formatTime(
			now.getTime(),
			zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
			shownDateLocale(),
			me?.hourCycle,
		),
	);
	const date = $derived(
		new Intl.DateTimeFormat(shownDateLocale(), {
			weekday: 'long',
			day: 'numeric',
			month: 'long',
			...(zone && { timeZone: zone }),
		}).format(now),
	);
</script>

<svelte:head><title>{t('display_title')}</title></svelte:head>

{#snippet status()}
	{#key refreshKey}
		{#each statuses as pill (pill.id)}
			{#await trackWork(pill.component()) then mod}
				<mod.default />
			{/await}
		{/each}
	{/key}
{/snippet}

{#snippet foot(shown: (index: number) => boolean, rows: () => number | undefined)}
	{#if empty}
		<p class="bg-idle text-ink-soft rounded-lg px-4 py-3 text-lg">{t('display_empty')}</p>
	{/if}
	{#key refreshKey}
		{#each widgets as widget, i (widget.id)}
			<!-- Every widget stays mounted; one the screen has no room for is only not shown. -->
			<div class="widget" class:gone={!shown(i)} data-widget={widget.id}>
				{#await trackWork(widget.component()) then mod}
					<mod.default rows={rows()} />
				{/await}
			</div>
		{/each}
	{/key}
{/snippet}

{#if phase === 'loading'}
	<main class="bg-wall text-ink-soft grid min-h-dvh place-items-center text-2xl">
		{unreachable ? t('display_unreachable') : t('display_loading')}
	</main>
{:else if phase === 'signedIn'}
	<main class="bg-wall text-ink grid min-h-dvh place-items-center p-8">
		<div class="grid max-w-2xl gap-4 text-center">
			<h1 class="text-4xl font-extrabold">{t('display_signed_in_title')}</h1>
			<p class="text-ink-soft text-xl">{t('display_signed_in_text')}</p>
			<a href="/" class="text-info text-xl font-bold underline">{t('display_signed_in_back')}</a>
		</div>
	</main>
{:else if phase === 'unpaired'}
	{#key pairKey}
		<PairScreen
			onpaired={() => {
				justPaired = true;
				void check();
			}}
		/>
	{/key}
{:else}
	<!-- A wall display is never scrolled: Today fits the screen (FamilyToday), nothing runs past it. -->
	<main class="bg-wall text-ink relative h-dvh overflow-hidden">
		<!-- Today in family mode, one type step larger than on a person's screen (FamilyToday). -->
		<div class="family">
			{#if me && membersLoaded}
				{#key me.showNames}
					<FamilyToday
						style={appearance.style}
						showNames={me.showNames}
						disabledExtensions={() => me?.disabledExtensions ?? []}
						hidden={() => me?.hidden ?? []}
						reloadKey={refreshKey}
						{status}
						{foot}
						onfit={reportFit}
					/>
				{/key}
			{/if}
		</div>

		<p class="text-ink-soft absolute end-3 bottom-1.5 text-[11px] opacity-60">
			{me?.name}{unreachable ? ` · ${t('display_unreachable')}` : ''}
		</p>

		<!-- Ambient mode: contributed by an extension, covers Today after a while idle. -->
		{#each ambient as layer (layer.id)}
			{#await trackWork(layer.component()) then mod}
				<mod.default {time} {date} />
			{/await}
		{/each}
	</main>
{/if}

<style>
	.family {
		height: 100%;
		padding: 20px 16px 24px;
	}
	@media (min-width: 1024px) {
		.family {
			padding: 28px 40px 28px;
		}
	}
	.widget {
		min-width: 0;
	}
	.widget:empty,
	.gone {
		display: none;
	}
</style>
