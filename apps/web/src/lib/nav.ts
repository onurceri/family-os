import { type NavContribution, SETTINGS_SECTIONS, type SettingsSection } from '@famos/ui/slots';
import {
	Bell,
	Blocks,
	BookmarkPlus,
	CheckCheck,
	DatabaseBackup,
	Eye,
	Gauge,
	KeyRound,
	Mail,
	MapPin,
	Paintbrush,
	Palette,
	Send,
	ShieldCheck,
	Smartphone,
	Sparkles,
	Sun,
	UserRound,
	Users,
} from '@lucide/svelte';
import type { Component } from 'svelte';
import { contributions, enabledOnly } from './extensions';
import { getLocale, tDynamic } from './i18n.svelte';
import { byName, groupedByName, orderedBy, settingsByName } from './nav-order';

/**
 * Navigation model:
 *   phone  — bottom tabs: Today · up to 3 primary pages · More
 *   wide   — labelled rail: Today · all primary pages · More
 * Everything else is listed on the More page (Household) and in the settings list. New pages never break the layout.
 */

export interface NavItem {
	id: string;
	path: string;
	labelKey: string;
	icon?: Component;
	group?: string;
	/** For settings pages: the part of the settings list (see SETTINGS_SECTIONS). */
	section?: SettingsSection;
	/** Lower comes first. */
	order?: number;
	/** For settings pages: stays at the top of its part of the list, before the alphabetical rest. */
	first?: boolean;
	/** Capability needed to see this entry. */
	requires?: string;
	/** The page where things are shared with the family (its key is `n`). */
	share?: boolean;
	/** The key that opens the page after `g`. */
	shortcut?: string;
	/** Other pages that belong to this entry (the settings list marks it while they are open). */
	alsoOn?: string[];
	badge?: () => Promise<number>;
	/** Pages under this entry: a group in the sidebar, one entry on the phone and the rail. */
	children?: NavItem[];
}

/**
 * The settings entry a page belongs to: the longest entry path that is the page or a parent of it,
 * or the entry that lists the page in `alsoOn` (AI activity belongs to Usage & limits).
 */
export function settingsOwner<T extends Pick<NavItem, 'path' | 'alsoOn'>>(
	items: readonly T[],
	path: string,
): T | undefined {
	const reaches = (base: string) => path === base || path.startsWith(`${base}/`);
	return items
		.flatMap((item) =>
			[item.path, ...(item.alsoOn ?? [])].filter(reaches).map((base) => ({ item, base })),
		)
		.toSorted((a, b) => b.base.length - a.base.length)[0]?.item;
}

export const PHONE_PRIMARY_SLOTS = 3;

export const TODAY: NavItem = { id: 'core.today', path: '/', labelKey: 'nav_home', icon: Sun };

/**
 * Pages owned by the app itself, all of them settings (the settings list; More on phones). Their
 * `order` leaves room for the pages extensions add to a part of the list (Photos and weather, 35,
 * comes after Devices and displays); on a tie the app's own page comes first. Each entry is also
 * its page's declaration: its `requires` is who may open the page (and the pages under its path
 * or in its `alsoOn`), so the entry and the page cannot disagree.
 */
export const APP_SETTINGS: readonly NavItem[] = [
	{
		id: 'core.account',
		order: 10,
		path: '/settings/profile',
		labelKey: 'nav_profile',
		icon: UserRound,
		group: 'settings',
		section: 'you',
		first: true,
	},
	{
		id: 'core.appearance',
		order: 20,
		path: '/settings/appearance',
		labelKey: 'nav_appearance',
		icon: Palette,
		group: 'settings',
		section: 'you',
	},
	{
		id: 'core.notificationSettings',
		order: 30,
		path: '/settings/notifications',
		labelKey: 'nav_notifications',
		icon: Bell,
		group: 'settings',
		section: 'you',
		requires: 'core.notifications.receive',
	},
	{
		id: 'core.memory',
		order: 40,
		path: '/settings/memory',
		labelKey: 'nav_memory',
		icon: BookmarkPlus,
		group: 'settings',
		section: 'you',
		requires: 'core.memory.use',
	},
	{
		id: 'core.connectedApps',
		order: 45,
		path: '/settings/connected-apps',
		labelKey: 'nav_connected_apps',
		icon: KeyRound,
		group: 'settings',
		section: 'you',
		requires: 'core.mcp.use',
	},
	{
		id: 'core.members',
		order: 10,
		path: '/settings/members',
		labelKey: 'nav_members',
		icon: Users,
		group: 'settings',
		section: 'family',
		requires: 'core.members.manage',
	},
	{
		id: 'core.roles',
		order: 20,
		path: '/settings/roles',
		labelKey: 'nav_roles',
		icon: ShieldCheck,
		group: 'settings',
		section: 'family',
		requires: 'core.roles.manage',
	},
	{
		id: 'core.devices',
		order: 30,
		path: '/settings/devices',
		labelKey: 'nav_devices_displays',
		icon: Smartphone,
		group: 'settings',
		section: 'family',
		requires: 'core.devices.manage',
	},
	{
		id: 'core.extensions',
		order: 40,
		path: '/settings/extensions',
		labelKey: 'nav_extensions',
		icon: Blocks,
		group: 'settings',
		section: 'family',
		requires: 'core.extensions.manage',
	},
	{
		id: 'core.region',
		order: 42,
		path: '/settings/region',
		labelKey: 'nav_language_region',
		icon: MapPin,
		group: 'settings',
		section: 'family',
		requires: 'core.settings.manage',
	},
	{
		id: 'core.theme',
		order: 44,
		path: '/settings/theme',
		labelKey: 'nav_theme',
		icon: Paintbrush,
		group: 'settings',
		section: 'family',
		requires: 'core.settings.manage',
	},
	{
		id: 'core.ai',
		order: 10,
		path: '/settings/ai',
		labelKey: 'nav_ai',
		icon: Sparkles,
		group: 'settings',
		section: 'ai',
		requires: 'core.ai.manage',
	},
	{
		id: 'core.aiPrivacy',
		order: 20,
		path: '/settings/ai/privacy',
		labelKey: 'nav_ai_privacy',
		icon: Eye,
		group: 'settings',
		section: 'ai',
		requires: 'core.ai.manage',
	},
	{
		id: 'core.aiUsage',
		order: 30,
		path: '/settings/ai/usage',
		labelKey: 'nav_ai_usage',
		alsoOn: ['/settings/ai/activity'],
		icon: Gauge,
		group: 'settings',
		section: 'ai',
		requires: 'core.ai.manage',
	},
	{
		id: 'core.autoApproval',
		order: 40,
		path: '/settings/auto-approval',
		labelKey: 'nav_auto_approval',
		icon: CheckCheck,
		group: 'settings',
		section: 'ai',
		requires: 'core.autoApprove.manage',
	},
	{
		id: 'core.backups',
		order: 10,
		path: '/settings/backups',
		labelKey: 'nav_backups',
		icon: DatabaseBackup,
		group: 'settings',
		section: 'system',
		requires: 'core.settings.manage',
	},
	{
		id: 'core.email',
		order: 20,
		path: '/settings/email',
		labelKey: 'nav_email',
		icon: Mail,
		group: 'settings',
		section: 'system',
		requires: 'core.settings.manage',
	},
	{
		id: 'core.telegram',
		order: 30,
		path: '/settings/telegram',
		labelKey: 'nav_telegram',
		icon: Send,
		group: 'settings',
		section: 'system',
		requires: 'core.settings.manage',
	},
];

/** The app's own page on a path, as the shell checks it before opening it. */
export const appPageFor = (path: string): NavItem | undefined => settingsOwner(APP_SETTINGS, path);

type Can = (capability: string) => boolean;
const allowed = (item: { requires?: string | undefined }, can: Can) =>
	!item.requires || can(item.requires);

export interface NavModel {
	/** Rail: every primary page. */
	primary: NavItem[];
	/** Phone tabs: the first few primary pages. */
	phonePrimary: NavItem[];
	/** "More" page, grouped; includes primary pages that did not fit on the phone. */
	moreGroups: { group: string; items: NavItem[] }[];
	/** Settings pages by part of the list, in the order of SETTINGS_SECTIONS. */
	settings: { section: SettingsSection; items: NavItem[] }[];
	/** Sidebar (wide screens): the pages extensions place in "More", by group; no settings. */
	household: { group: string; items: NavItem[] }[];
}

export function buildNav(
	can: Can,
	/** Turned-off extensions, whose pages disappear from navigation. */
	disabled: readonly string[] = [],
	entries: readonly NavContribution[] = contributions.nav,
	byOrder = orderedBy(tDynamic, getLocale()),
	name = byName(tDynamic, getLocale()),
): NavModel {
	const visible = enabledOnly(entries, disabled)
		.filter((c) => allowed(c, can))
		.map(({ children, ...c }): Omit<NavContribution, 'children'> & Pick<NavItem, 'children'> => {
			const shown = children?.filter((child) => allowed(child, can));
			return shown?.length ? { ...c, children: shown } : c;
		});
	const primary = visible.filter((c) => c.placement === 'primary').toSorted(byOrder);
	const phonePrimary = primary.slice(0, PHONE_PRIMARY_SLOTS);
	const overflow = primary
		.slice(PHONE_PRIMARY_SLOTS)
		.map((c) => ({ ...c, group: c.group ?? 'pages' }));
	const more = [...overflow, ...visible.filter((c) => c.placement === 'more').toSorted(byOrder)];
	const groupBy = (items: NavItem[]) => groupedByName(items, name);
	// The app's own settings and the pages extensions add; each part of the list is then ordered by name.
	const settingsItems = [
		...APP_SETTINGS.filter((i) => allowed(i, can)),
		...visible.filter((c) => c.placement === 'more' && c.group === 'settings'),
	];
	const settings = settingsByName(settingsItems, SETTINGS_SECTIONS, 'system', name);
	return {
		settings,
		household: groupBy(
			visible
				.filter((c) => c.placement === 'more' && c.group !== 'settings' && c.group !== 'account')
				.toSorted(byOrder),
		),
		primary,
		phonePrimary,
		moreGroups: groupBy(more.filter((i) => i.group !== 'settings')),
	};
}

/** Settings pages are shown in settings mode: the settings list replaces the app sidebar. */
const SETTINGS_PREFIXES = ['/settings', '/more/'];
export const isSettingsPath = (path: string) =>
	SETTINGS_PREFIXES.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`));
