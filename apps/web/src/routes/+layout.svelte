<script lang="ts">
	import '../app.css';
	import { afterNavigate, goto } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import { ChevronLeft, Ellipsis } from '@lucide/svelte';
	import { untrack } from 'svelte';
	import {
		bootLanguage,
		getDirection,
		getLocale,
		loadLanguages,
		setLocale,
		t,
		tDynamic,
	} from '#lib/i18n.svelte.js';
	import { appearance } from '#lib/appearance.svelte.js';
	import { awaiting } from '#lib/awaiting.svelte.js';
	import { notifications } from '#lib/notifications.svelte.js';
	import { offline } from '#lib/offline.svelte.js';
	import OfflineStatus from '#lib/OfflineStatus.svelte';
	import NotificationsBell from '#lib/NotificationsBell.svelte';
	import Sidebar from '#lib/Sidebar.svelte';
	import SettingsSidebar from '#lib/SettingsSidebar.svelte';
	import { settingsOrigin } from '#lib/settings-origin.svelte.js';
	import { signOut } from '#lib/auth.js';
	import {
		APP_SETTINGS,
		appPageFor,
		buildNav,
		isSettingsPath,
		type NavItem,
		settingsOwner,
		TODAY,
	} from '#lib/nav.js';
	import NoAccess from '#lib/NoAccess.svelte';
	import { OPEN, pageAccess } from '#lib/page-access.js';
	import { connectRealtime, onEvent, onReconnect } from '#lib/realtime.js';
	import { onExtensionsChanged } from '#lib/server-changes.js';
	import { accessBook } from '#lib/access.svelte.js';
	import { session } from '#lib/session.svelte.js';
	import { enableServiceWorkerUpdates } from '#lib/sw-update.js';
	import { dayNight, followDayNight } from '#lib/theme.svelte.js';
	import { toasts } from '#lib/toast.svelte.js';
	import { refusalKey, refusalOfError } from '#lib/refusal.js';
	import { shareFor } from '#lib/contributions.js';
	import {
		contributions,
		enabledOnly,
		isAppPath,
		keepExtensionsOffline,
		pageFor,
	} from '#lib/extensions.js';
	import { family } from '#lib/family.svelte.js';
	import { familyDateLocale } from '#lib/format.svelte.js';
	import LoadingMark from '#lib/LoadingMark.svelte';
	import { netActivity, shellState } from '#lib/net-activity.svelte.js';
	import PageGate from '#lib/PageGate.svelte';
	import PreviewBar from '#lib/PreviewBar.svelte';
	import { provideAppContext } from '@famos/ui/app';
	import { Avatar, beginWork, Toast } from '@famos/ui/famos';
	import Slot from '@famos/ui/slot';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// Counts reads in flight, so a page can stay hidden until its first data is in (PageGate).
	netActivity.install();
	// A refused change means the role changed since the controls were drawn: read it again.
	let lastRefused = 0;
	netActivity.onForbidden = (reason) => {
		// Said once, in words, whoever asked: a page, an extension or the offline queue.
		// Not before sign-in: a wrong code there is the form's to explain.
		if (session.status !== 'ready') return;
		toasts.refuse(tDynamic(`app:${refusalKey(reason)}`));
		if (Date.now() - lastRefused < 3000) return;
		lastRefused = Date.now();
		void session.refresh();
	};
	// A navigation on its way is work too: the page it leads to (a list's first item opening by
	// itself) only starts its reads once it has arrived.
	$effect(() => {
		if (navigating.to) return beginWork();
	});

	const PUBLIC = new Set(['/setup', '/login']);
	/**
	 * Without a session there is one page to be on: setup on a new instance, sign-in otherwise.
	 * Any other page waits for the guard's redirect unrendered, so it never starts its reads (and
	 * their 401s) on the way.
	 */
	const signedOutPage = $derived(
		session.status === 'setup' ? '/setup' : session.status === 'anonymous' ? '/login' : null,
	);
	/** Long enough to be seen by someone who looks away for a while; a newer notice replaces it. */
	const CHANGED_TOAST_MS = 5 * 60_000;
	const MORE: NavItem = { id: 'core.more', path: '/more', labelKey: 'nav_more', icon: Ellipsis };

	const nav = $derived(
		buildNav((capability) => session.can(capability), session.disabledExtensions),
	);
	const path = $derived(page.url.pathname);
	// The family display is its own world: no sign-in, no navigation, its own data.
	const isDisplay = $derived(path === '/display' || path.startsWith('/display/'));
	// Settings mode: the settings list replaces the app sidebar.
	const settingsMode = $derived(!isDisplay && (path === '/more' || isSettingsPath(path)));
	const isActive = (item: NavItem) =>
		item === MORE
			? settingsMode
			: settingsMode
				? false
				: item.path === '/'
					? path === '/'
					: path === item.path || path.startsWith(`${item.path}/`);
	/**
	 * Whether the viewer may open this page, asked once here for every page: the app's own (their
	 * settings entry is their declaration) and the extensions' (their page's `requires`).
	 */
	const access = $derived.by(() => {
		if (session.status !== 'ready') return OPEN;
		const can = (capability: string) => session.can(capability);
		return page.route.id === '/[...path]'
			? pageAccess({
					path,
					page: pageFor(path)?.page,
					entries: contributions.nav,
					can,
				})
			: pageAccess({ path, page: appPageFor(path), entries: APP_SETTINGS, can });
	});
	const label = (item: NavItem) =>
		item.labelKey.includes(':') ? tDynamic(item.labelKey) : tDynamic(`app:${item.labelKey}`);

	// What extension UIs may use (they cannot import the app's modules).
	provideAppContext({
		t: (key, options) => tDynamic(key, options),
		locale: () => getLocale(),
		formatLocale: () => family.formatLocale,
		dateLocale: familyDateLocale,
		weekStart: () => family.weekStart,
		hourCycle: () => family.hourCycle,
		temperatureUnit: () => family.temperatureUnit,
		members: () => family.members,
		me: () =>
			session.me
				? {
						id: session.me.id,
						displayName: session.me.displayName,
						color: session.me.color,
						roleId: session.me.roleId,
						nextUp: session.me.nextUp,
					}
				: null,
		timeZone: () => family.timeZone,
		onEvent,
		draftPresenter: (actionId) => contributions.presenters.get(actionId),
		can: (capability) => session.can(capability),
		slots: (name) =>
			enabledOnly(
				contributions.slots.filter(
					(c) => c.slot === name && (!c.requires || session.can(c.requires)),
				),
				session.disabledExtensions,
			) as never,
		isAppPath: (path) => isAppPath(path, session.disabledExtensions),
		share: () =>
			shareFor(contributions.share, {
				can: (capability) => session.can(capability),
				disabledExtensions: session.disabledExtensions,
			}),
		toast: (message, action) => toasts.show(message, action),
		failureText: (error, fallback) => {
			const refusal = refusalOfError(error);
			return refusal ? tDynamic(`app:${refusalKey(refusal.reason)}`) : fallback;
		},
		sentForApproval: () => {
			const place = shareFor(contributions.share, {
				can: (capability) => session.can(capability),
				disabledExtensions: session.disabledExtensions,
			});
			toasts.show(
				t('draft_sent_for_approval'),
				place && { label: t('draft_sent_show'), run: () => void goto(place.path) },
			);
		},
		access: (actionId) => accessBook.access(actionId),
		accessFor: (actionId, input) => accessBook.accessFor(actionId, input),
		approval: (actionId, input) => {
			const answer =
				input === undefined ? accessBook.access(actionId) : accessBook.accessFor(actionId, input);
			return answer === 'suggest'
				? { note: t('draft_approval_note'), saveLabel: t('send_for_approval') }
				: undefined;
		},
		awaitsApproval: (id) => awaiting.has(id),
		awaitedChange: (id) => awaiting.get(id),
		runAction: (actionId, input, options) => offline.run(actionId, input, options),
		waiting: () => offline.waitingChanges(),
		offline: () => offline.showingOld,
		query: () => new URLSearchParams(page.url.search),
		setQuery: (changes, options) => {
			const url = new URL(page.url.href);
			for (const [key, value] of Object.entries(changes)) {
				if (value === null) url.searchParams.delete(key);
				else url.searchParams.set(key, value);
			}
			void goto(`${url.pathname}${url.search}`, {
				replace: options?.replace ?? false,
			});
		},
	});

	// The language of someone who has not signed in: what they chose here, else their browser's.
	// The display chooses its own (the family's) from its pairing.
	$effect(() => {
		if (!isDisplay && session.status !== 'ready' && session.status !== 'loading')
			void bootLanguage(() => session.status !== 'ready');
	});
	// Signed in: the person's own language, else the family's. Only the code matters: a
	// session or family read again with the same language loads nothing again.
	const shellLanguage = $derived(
		isDisplay || session.status !== 'ready' || !family.loaded
			? null
			: (session.me?.locale ?? family.locale),
	);
	$effect(() => {
		if (session.status !== 'ready') shellState.languageReady = false;
	});
	$effect(() => {
		const code = shellLanguage;
		if (code === null) return;
		void loadLanguages()
			.then(() => setLocale(code))
			.finally(() => {
				shellState.languageReady = true;
			});
	});
	// The shell (navigation, the page) waits for the language and the family's formats, so it never
	// draws in English and a 12-hour clock first and then again (6 s at most, then it shows as is).
	let shellGaveUp = $state(false);
	const shellReady = $derived((family.loaded && shellState.languageReady) || shellGaveUp);
	$effect(() => {
		if (session.status !== 'ready' || untrack(() => shellReady)) return;
		const timer = setTimeout(() => (shellGaveUp = true), 6000);
		return () => clearTimeout(timer);
	});
	$effect(() => {
		document.documentElement.lang = getLocale();
		document.documentElement.dir = getDirection();
	});
	// The theme: the person's own, else the family's; before sign-in the family's.
	// It follows who is signed in; the display picks its own from its pairing.
	$effect(() => {
		if (isDisplay || session.status === 'loading') return;
		void session.me?.id;
		void appearance.refresh();
	});
	// Trying a style or a theme (Settings → Appearance) lasts across pages until it is decided; it
	// ends when the person signs out or someone else signs in.
	let previewOwner: string | null = null;
	$effect(() => {
		if (isDisplay) return;
		if (session.status === 'anonymous' || session.status === 'setup') {
			appearance.endPreviews();
			previewOwner = null;
			return;
		}
		const id = session.me?.id;
		if (!id) return;
		if (previewOwner !== null && previewOwner !== id) appearance.endPreviews();
		previewOwner = id;
	});
	/** The preview bar takes room at the foot of every page. */
	const previewBar = $derived(
		appearance.previewingStyle !== null ||
			(appearance.previewing !== null && !appearance.previewingForFamily),
	);

	// Keyboard shortcuts: n Quick add, g t Today, g and the key a navigation entry names
	// (`shortcut`). "/" focuses search on the pages that have one. Ignored while typing.
	let goPending = false;
	let goTimer: ReturnType<typeof setTimeout> | undefined;
	function shortcuts(e: KeyboardEvent) {
		if (isDisplay || session.status !== 'ready') return;
		if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
		const el = e.target as HTMLElement | null;
		if (el?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
			return;
		if (document.querySelector('[role="dialog"], [role="menu"]')) return;
		if (goPending) {
			goPending = false;
			clearTimeout(goTimer);
			const target =
				e.key === 't' ? '/' : (nav.primary.find((i) => i.shortcut === e.key)?.path ?? null);
			if (target) {
				e.preventDefault();
				void goto(target);
			}
			return;
		}
		if (e.key === 'g') {
			goPending = true;
			goTimer = setTimeout(() => (goPending = false), 1200);
		} else if (e.key === 'n') {
			const button = [
				...document.querySelectorAll<HTMLElement>('[data-testid="quick-add-button"]'),
			].find((b) => b.offsetParent !== null);
			if (button) {
				e.preventDefault();
				button.click();
			}
		}
	}

	// "Back to FamilyOS" returns to the last page outside settings (and outside More).
	afterNavigate(({ to }) => {
		if (!to) return;
		const p = to.url.pathname;
		if (p === '/more' || isSettingsPath(p) || PUBLIC.has(p) || p.startsWith('/display')) return;
		settingsOrigin.href = `${p}${to.url.search}`;
	});

	/**
	 * Below 1024 px a settings page is one level of a stack: Back goes up to the group's page in
	 * More, and from there to More itself.
	 */
	const stackBack = $derived.by(() => {
		if (path.startsWith('/more/')) return { href: '/more', label: t('nav_more') };
		const owner = settingsOwner(
			nav.settings.flatMap((s) => s.items.map((i) => ({ ...i, section: s.section }))),
			path,
		);
		return owner
			? {
					href: `/more/${owner.section}`,
					label: tDynamic(`app:settings_section_${owner.section}`),
				}
			: { href: '/more', label: t('nav_more') };
	});

	// Re-applied whenever this device's day/night choice changes.
	$effect(() => {
		void dayNight.mode;
		return followDayNight();
	});
	$effect(() => enableServiceWorkerUpdates());
	$effect(() => {
		keepExtensionsOffline();
	});
	$effect(() => {
		if (!isDisplay) void session.refresh();
	});

	// Route guard driven by session status.
	$effect(() => {
		if (isDisplay) return;
		if (session.status === 'setup' && path !== '/setup')
			// Keep `?code=` from the setup address printed in the server log.
			void goto(`/setup${page.url.search}`, { replace: true });
		else if (session.status === 'anonymous' && path !== '/login')
			void goto('/login', { replace: true });
		else if (session.status === 'ready' && PUBLIC.has(path)) void goto('/', { replace: true });
	});

	// A session that ended (signed out elsewhere, expired) leaves no member's reads cached.
	$effect(() => {
		if (!isDisplay && session.status === 'anonymous') offline.forgetReads();
	});

	// The offline queue: replays waiting changes of the signed-in member.
	$effect(() => {
		if (isDisplay || session.status !== 'ready') return;
		void session.me?.id;
		offline.resync();
		return offline.start();
	});

	// What the signed-in member's own changes wait on, read again when someone else signs in.
	$effect(() => {
		if (isDisplay || session.status !== 'ready') return;
		void session.me?.id;
		untrack(() => void awaiting.refresh());
	});

	// Live updates while signed in.
	$effect(() => {
		if (isDisplay || session.status !== 'ready') return;
		const disconnect = connectRealtime();
		void family.refresh();
		const off = onEvent('core.member.', () => {
			void session.refresh();
			void family.refresh();
		});
		// A role's capabilities changed: what the controls offer follows (me and access).
		const offRole = onEvent('core.role.', () => void session.refresh());
		// Family settings (language, region formats, time zone) changed on another device.
		const offFamily = onEvent('core.family.', () => void family.refresh());
		// Changes made while the socket was not yet (or no longer) open were missed.
		const offReconnect = onReconnect(() => {
			void family.refresh();
			void appearance.refresh();
			void awaiting.refresh();
			void accessBook.load();
		});
		// A language pack was installed, updated or removed: reload the list and the active pack.
		const offLanguages = onEvent('core.languages.', () => {
			void loadLanguages().then(() => setLocale(getLocale(), { force: true }));
			void family.refresh();
		});
		// A theme was installed, removed or chosen (here or on another device).
		const offThemes = onEvent('core.themes.', () => {
			void appearance.loadThemes();
			void appearance.refresh();
		});
		// An extension turned on or off changes navigation and capabilities everywhere.
		const offFeatures = onEvent('core.features.', () => void session.refresh());
		// The server restarted with other extensions: this page still runs the old ones. Reloading
		// is the person's choice, so nothing they are typing is lost.
		const offChanged = onExtensionsChanged(() =>
			toasts.show(
				t('extensions_changed'),
				{ label: t('extensions_changed_reload'), run: () => location.reload() },
				CHANGED_TOAST_MS,
			),
		);
		// What the member's own changes wait on: marked where the change was made.
		let awaitTimer: ReturnType<typeof setTimeout> | undefined;
		const offAwaiting = onEvent('core.draft.', () => {
			clearTimeout(awaitTimer);
			awaitTimer = setTimeout(() => void awaiting.refresh(), 300);
		});
		// Nav badges (e.g. suggestions waiting in Quick add) refresh after any change, debounced.
		void refreshBadges();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const offBadges = onEvent('', () => {
			clearTimeout(timer);
			timer = setTimeout(() => void refreshBadges(), 400);
		});
		return () => {
			off();
			offRole();
			offFamily();
			offReconnect();
			offLanguages();
			offThemes();
			offFeatures();
			offChanged();
			offBadges();
			offAwaiting();
			clearTimeout(timer);
			clearTimeout(awaitTimer);
			disconnect();
		};
	});

	let badges = $state<Record<string, number>>({});
	async function logout() {
		await signOut();
		await session.refresh();
	}
	/** Pages with a count (Quick add); the bell carries the unread notifications. */
	const badgeFor = (item: NavItem) => badges[item.id];
	/** On phones the bell lives on Today, so "More" keeps the count as well. */
	const tabBadge = (item: NavItem) => (item.id === MORE.id ? notifications.unread : badgeFor(item));
	async function refreshBadges() {
		void notifications.refresh().catch(() => {});
		const entries = await Promise.all(
			nav.primary
				.flatMap((item) => [item, ...(item.children ?? [])])
				.filter((item) => item.badge)
				.map(
					async (item) =>
						[item.id, await (item.badge as () => Promise<number>)().catch(() => 0)] as const,
				),
		);
		badges = Object.fromEntries(entries);
	}
</script>

<!-- Every page opens whole: hidden until its first data is in (PageGate). The extension pages are
     gated where they are mounted (routes/[...path]), keyed by the page component. A page that is
     not for the viewer is never mounted: they get the one state that says who it is for. -->
{#snippet routed()}
	{#if !access.open}
		{#key path}
			<PageGate>
				<NoAccess labelKey={access.labelKey} settings={isSettingsPath(path)} />
			</PageGate>
		{/key}
	{:else if page.route.id === '/[...path]'}
		{@render children()}
	{:else}
		{#key page.route.id}<PageGate>{@render children()}</PageGate>{/key}
	{/if}
{/snippet}

{#snippet navLink(item: NavItem, variant: 'tab' | 'rail')}
	{@const active = isActive(item)}
	<a
		href={item.path}
		aria-current={active ? 'page' : undefined}
		class={variant === 'tab'
			? 'flex min-h-12 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold ' +
				(active ? 'text-ink' : 'text-ink-soft')
			: 'flex w-16 flex-col items-center gap-1 rounded-xl px-1 py-2 text-[11px] font-semibold ' +
				(active ? 'bg-surface text-ink shadow-lit' : 'text-ink-soft hover:text-ink')}
	>
		<span class="relative">
			{#if item.icon}<item.icon class="size-5" aria-hidden="true" />{/if}
			{#if badgeFor(item)}
				<span
					class="bg-attention text-on-color absolute -top-1.5 -right-2.5 min-w-4 rounded-full px-1 text-center text-[10px] leading-4 font-bold tabular-nums"
					>{badgeFor(item)}<span class="sr-only"> · {t('nav_waiting')}</span></span
				>
			{/if}
		</span>
		<span class="max-w-full truncate">{label(item)}</span>
	</a>
{/snippet}

<svelte:window onkeydown={shortcuts} />

{#if isDisplay}
	{@render children()}
{:else if session.status === 'ready' && session.me && shellReady}
	<div class="min-h-dvh md:grid md:grid-cols-[5rem_1fr] lg:grid-cols-[15.5rem_1fr]">
		<!-- Tablets: labelled rail -->
		<nav
			aria-label={t('nav_label')}
			class="bg-wall sticky top-0 z-30 hidden h-dvh flex-col items-center gap-1 border-r py-4 md:flex lg:hidden"
		>
			<a
				href="/"
				aria-label={t('app_name')}
				class="focus-visible:ring-ring mb-1 grid size-11 place-items-center rounded-xl outline-none focus-visible:ring-2"
			>
				<img src="/favicon.svg" alt="" class="size-[30px] shrink-0" />
			</a>
			<Slot name="nav.action" props={{ variant: 'rail' }} />
			<NotificationsBell mode="popover" placement="right" size={44} />
			<div class="h-2"></div>
			{@render navLink(TODAY, 'rail')}
			{#each nav.primary as item (item.id)}{@render navLink(item, 'rail')}{/each}
			{@render navLink(MORE, 'rail')}
			<a
				href="/more"
				class="text-ink-soft mt-auto flex flex-col items-center gap-1 text-[11px] font-semibold"
				aria-label={session.me.displayName}
			>
				<Avatar name={session.me.displayName} color={session.me.color} size={36} />
				<span class="max-w-16 truncate">{session.me.displayName}</span>
			</a>
		</nav>

		{#if settingsMode}
			<SettingsSidebar {nav} current={path} onsignout={logout} />
		{:else}
			<Sidebar
				{nav}
				today={TODAY}
				more={MORE}
				{isActive}
				{label}
				badge={badgeFor}
				onsignout={logout}
			/>
		{/if}

		<!-- The shell keeps only the gutters; every page's width and centring is its `<Page>` frame's
		     (@famos/ui). The gutters are told to the frame as `--shell-*`, so a page that bleeds into
		     them (the Board) or fills the window (the Assistant) follows them, the preview bar too. -->
		<main
			class="w-full min-w-0 [--shell-top:1.5rem] [--shell-x:1rem] lg:[--shell-top:2rem] lg:[--shell-x:2.5rem] {previewBar
				? '[--shell-bottom:13rem] md:[--shell-bottom:7rem]'
				: '[--shell-bottom:9rem] md:[--shell-bottom:2.5rem]'} px-(--shell-x) pt-(--shell-top) pb-(--shell-bottom)"
		>
			<OfflineStatus />
			{#if settingsMode && path !== '/more'}
				<a
					href={stackBack.href}
					data-testid="stack-back"
					class="text-ink-soft hover:text-ink focus-visible:ring-ring -mt-2 mb-3 flex min-h-11 w-fit items-center gap-1 rounded-xl pe-3 text-[15px] font-semibold outline-none focus-visible:ring-2 lg:hidden"
				>
					<ChevronLeft class="size-5" aria-hidden="true" />{stackBack.label}
				</a>
			{/if}
			{@render routed()}
		</main>

		<!-- Phones: bottom tabs -->
		<nav
			aria-label={t('nav_label')}
			class="bg-surface fixed inset-x-0 bottom-0 grid grid-cols-5 border-t px-1 pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden"
			style:grid-template-columns="repeat({nav.phonePrimary.length + 2}, minmax(0, 1fr))"
		>
			{@render navLink(TODAY, 'tab')}
			{#each nav.phonePrimary as item (item.id)}{@render navLink(item, 'tab')}{/each}
			{@render navLink(MORE, 'tab')}
		</nav>

		<PreviewBar />
	</div>
{:else}
	<main class="mx-auto max-w-5xl px-4 py-6">
		{#if session.status === 'loading' || session.status === 'ready'}
			<!-- Nothing until the session, the language and the family's formats are known; the
			     indicator only shows if this takes long. -->
			<LoadingMark />
		{:else if session.status === 'offline'}
			<p class="text-destructive">{t('error_generic')}</p>
		{:else if path === signedOutPage}
			{@render routed()}
		{/if}
	</main>
{/if}

{#if toasts.current}
	{#key toasts.current.id}
		<Toast
			message={toasts.current.message}
			actionLabel={toasts.current.actionLabel}
			onaction={toasts.current.onaction}
			onhold={() => toasts.hold()}
			onrelease={() => toasts.release()}
		/>
	{/key}
{/if}
