import {
	type Actor,
	type DbExecutor,
	defineAction,
	defineEvent,
	defineJob,
	defineRoute,
	EVERYONE,
	FamosError,
	FileResponseSchema,
	isFamosError,
	systemActor,
	TextResponseSchema,
} from '@famos/sdk';
import { z } from 'zod';
import { CORE_CAPABILITIES } from './core-capabilities.ts';
import { readJson, writeJson } from './settings-json.ts';
import type { CoreTables } from './tables.ts';

/**
 * Themes. Core knows no theme by name: a theme is any pack the registry holds. The
 * packs themselves (files, validation, the generated stylesheet) live in the composition root
 * behind `ThemePort`; core stores which packs were installed and who chose which theme, and
 * offers the actions and routes around it. Like language packs, a pack is data, never code.
 */

/** The theme everything falls back to; the bundled Ev Işığı pack. */
export const DEFAULT_THEME = 'ev-isigi';

export const ThemeIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);

/**
 * Styles: how Today and the display are arranged, with their type ramp and fonts.
 * Unlike a theme a style is code the app ships (the registry is `STYLES` in `@famos/ui`), so
 * core knows the ids; the two lists are kept equal by a type check in the web app.
 */
export const STYLE_IDS = ['broadsheet', 'lanes', 'wall'] as const;
export type StyleId = (typeof STYLE_IDS)[number];
/** The style everything falls back to. */
export const DEFAULT_STYLE: StyleId = 'broadsheet';
export const StyleIdSchema = z.enum(STYLE_IDS);
const isStyle = (id: unknown): id is StyleId =>
	typeof id === 'string' && (STYLE_IDS as readonly string[]).includes(id);

/**
 * What Today shows: the blocks a person, the family or a display hides (the app knows the
 * blocks; core keeps only their ids). Stored as what is hidden, so a block that is new or that
 * core does not know is shown by default.
 */
export const TodayBlockIdSchema = z.string().regex(/^[a-z][a-zA-Z0-9._-]{0,79}$/);
export const HiddenBlocksSchema = z.array(TodayBlockIdSchema).max(100);
const hiddenOf = (value: unknown): string[] | null =>
	Array.isArray(value)
		? [...new Set(value.filter((id): id is string => TodayBlockIdSchema.safeParse(id).success))]
		: null;

/**
 * What a family display shows between Today's turns: pages other extensions offer (their
 * `display.page` contributions, which only the web app knows, so the ids are not checked here;
 * the display skips one it cannot show). Today always comes first and comes back after
 * `backSeconds` without a touch.
 */
export const PAGE_ID = /^[a-z][a-z0-9-]*\.[a-zA-Z0-9.-]+$/;
export const MAX_DISPLAY_PAGES = 8;
export const RotationSchema = z.object({
	pages: z
		.array(z.string().max(100).regex(PAGE_ID))
		.max(MAX_DISPLAY_PAGES)
		.refine((ids) => new Set(ids).size === ids.length, 'A page can be added once'),
	/** How long Today stays before the first page. */
	todaySeconds: z.number().int().min(30).max(3600).default(120),
	/** How long each page stays. */
	pageSeconds: z.number().int().min(10).max(600).default(30),
	/** After a touch, how long the screen holds before it goes back to Today. */
	backSeconds: z.number().int().min(30).max(3600).default(120),
});
export type Rotation = z.infer<typeof RotationSchema>;

const PreviewSchema = z.object({
	day: z.record(z.string(), z.string()),
	night: z.record(z.string(), z.string()),
});

export const ThemeSchema = z.object({
	id: ThemeIdSchema,
	name: z.string(),
	/** The pack's version plus a fingerprint of its content: changes whenever the look does. */
	version: z.string(),
	authors: z.array(z.string()),
	/** `bundled`: shipped with the app; `installed`: added by an admin. */
	source: z.enum(['bundled', 'installed']),
	/** An installed pack that replaces a bundled one of the same id. */
	overridesBundled: z.boolean(),
	/** Colors for the theme's swatches: a few tokens of each palette. */
	preview: PreviewSchema,
	/** The style the pack suggests while the family has not chosen one. */
	style: StyleIdSchema.nullable(),
	installedAt: z.number().nullable(),
	/** Where an installed pack was fetched from, when it was fetched. */
	url: z.string().nullable(),
});
export type Theme = z.infer<typeof ThemeSchema>;

/** The port's own view of a pack (no install record). */
export type ThemeSummary = Omit<Theme, 'installedAt' | 'url'>;

/** A pack as sent by a client: the manifest, the tokens and the fonts as base64 by file name. */
export const ThemePackInputSchema = z.object({
	manifest: z.record(z.string(), z.unknown()),
	tokens: z.record(z.string(), z.unknown()),
	fonts: z.record(z.string(), z.string()).optional(),
});
export type ThemePackInput = z.infer<typeof ThemePackInputSchema>;

/** What core needs from the theme registry the composition root builds. */
export interface ThemePort {
	list(): ThemeSummary[];
	has(id: string): boolean;
	/** The generated stylesheet of a theme; null for unknown ids. */
	stylesheet(id: string): { version: string; css: string } | null;
	/** A font file of a theme's own pack; null when there is none by that name. */
	font(id: string, file: string): { stream: AsyncIterable<Uint8Array>; size: number } | null;
	/** Validates and stores an installed pack. Throws `FamosError('bad_request')` listing what is wrong. */
	install(pack: unknown): Promise<{ theme: ThemeSummary; warnings: string[] }>;
	/** Removes an installed pack (a bundled one is only un-overridden). Throws when nothing is installed. */
	remove(id: string): Promise<void>;
}

/** Without a registry (tests): the default theme is listed, with no stylesheet of its own. */
export const defaultThemes: ThemePort = {
	list: () => [
		{
			id: DEFAULT_THEME,
			name: 'Ev Işığı',
			version: '1.0.0',
			authors: [],
			source: 'bundled',
			overridesBundled: false,
			preview: { day: {}, night: {} },
			style: null,
		},
	],
	has: (id) => id === DEFAULT_THEME,
	stylesheet: () => null,
	font: () => null,
	install: () => Promise.reject(new FamosError('bad_request', 'Theme packs are not available')),
	remove: () => Promise.reject(new FamosError('not_found', 'Theme packs are not available')),
};

/** Themes were installed, removed or chosen, or a style was chosen: open screens reload. */
export const themesChanged = defineEvent(
	'core.themes.changed',
	z.object({ id: z.string().nullable() }),
	{ audience: EVERYONE },
);

const INSTALLED_KEY = 'themes.installed';
const CHOICES_KEY = 'themes.choices';
/** Style choices, beside the theme choices and of the same shape. */
const STYLE_CHOICES_KEY = 'styles.choices';
/** The blocks hidden from Today, of the same shape: the family's, each person's, each display's. */
const TODAY_CHOICES_KEY = 'today.hidden';
/** The pages each display shows between Today's turns: `{ displays: { <device id>: Rotation } }`. */
const PAGES_KEY = 'displays.pages';
const FETCH_KEY = 'themes.fetch';
export const FETCH_THEME_JOB = 'core.fetchThemePack';

interface InstalledRecord {
	installedAt: number;
	url: string | null;
}
type InstalledMap = Record<string, InstalledRecord>;

/** Who chose what. Missing or unknown ids fall back, so nothing here can break the app. */
interface Choices {
	family: string | null;
	members: Record<string, string>;
	displays: Record<string, string>;
}
const NO_CHOICES: Choices = { family: null, members: {}, displays: {} };

/** Who hides what on Today; a missing entry follows the family (the family's default hides nothing). */
interface HiddenChoices {
	family: unknown;
	members: Record<string, unknown>;
	displays: Record<string, unknown>;
}

const FetchStateSchema = z.object({
	status: z.enum(['fetching', 'done', 'failed']),
	url: z.string(),
	/** A short reason in plain words when it failed; never the response body. */
	error: z.string().nullable(),
	at: z.number(),
});
type FetchState = z.infer<typeof FetchStateSchema>;

const AppearanceSchema = z.object({
	/** The theme this caller sees: a display's own, else the member's, else the family's. */
	theme: z.string().nullable(),
	/** Changes when the theme's look changes (cache key of the stylesheet). */
	version: z.string().nullable(),
	/** The family's default theme (after falling back). */
	family: z.string().nullable(),
	/** The caller's own choice; null follows the family. */
	mine: z.string().nullable(),
	/**
	 * The style this caller sees, first match wins: a display's own, the member's own,
	 * the family's, the preferred style of the theme above, else the default.
	 */
	style: StyleIdSchema,
	/** The family's chosen style; null when it never chose one (the theme's preference applies). */
	familyStyle: StyleIdSchema.nullable(),
	/** The caller's own style; null follows the family. */
	myStyle: StyleIdSchema.nullable(),
	/** The blocks Today hides for this caller: a display's own, else the member's, else the family's. */
	hidden: z.array(z.string()),
	/** The blocks the family's Today hides by default. */
	familyHidden: z.array(z.string()),
	/** The caller's own choice of what Today hides; null follows the family. */
	myHidden: z.array(z.string()).nullable(),
});

/** A pack with its fonts is at most 1.5 MB decoded; base64 adds a third. */
const MAX_PACK_URL_BYTES = 3 * 1024 * 1024;

export interface ThemesDeps {
	themes: () => ThemePort;
}

export function createThemes(deps: ThemesDeps) {
	const view = (summary: ThemeSummary, installed: InstalledMap): Theme => ({
		...summary,
		installedAt: installed[summary.id]?.installedAt ?? null,
		url: installed[summary.id]?.url ?? null,
	});

	const readChoices = async (db: DbExecutor): Promise<Choices> => ({
		...NO_CHOICES,
		...(await readJson<Partial<Choices>>(db, CHOICES_KEY, {})),
	});

	/** The first of the choices that names a theme which exists; the default when none does. */
	const firstKnown = (...ids: (string | null | undefined)[]): string | null => {
		const port = deps.themes();
		for (const id of ids) if (id && port.has(id)) return id;
		return port.has(DEFAULT_THEME) ? DEFAULT_THEME : (port.list()[0]?.id ?? null);
	};

	const readStyleChoices = async (db: DbExecutor): Promise<Choices> => ({
		...NO_CHOICES,
		...(await readJson<Partial<Choices>>(db, STYLE_CHOICES_KEY, {})),
	});

	/**
	 * The style a caller sees, first match wins: the display's own → the member's own →
	 * the family's → the preferred style of the theme resolved for the caller → the default. An id
	 * that is no longer a style is skipped, so a stored choice can never break the app.
	 */
	async function effectiveStyle(db: DbExecutor, actor: Actor | undefined, theme: string | null) {
		const choices = await readStyleChoices(db);
		const familyStyle = isStyle(choices.family) ? choices.family : null;
		let myStyle: StyleId | null = null;
		let own: string | undefined;
		if (actor?.kind === 'display') own = choices.displays[actor.deviceId];
		else if (actor?.kind === 'member') {
			const chosen = choices.members[actor.memberId];
			myStyle = isStyle(chosen) ? chosen : null;
			own = myStyle ?? undefined;
		}
		const preferred = theme
			? deps
					.themes()
					.list()
					.find((t) => t.id === theme)?.style
			: undefined;
		const style = [own, familyStyle, preferred].find(isStyle) ?? DEFAULT_STYLE;
		return { style, familyStyle, myStyle };
	}

	const readHidden = async (db: DbExecutor): Promise<HiddenChoices> => {
		const stored = await readJson<Partial<HiddenChoices>>(db, TODAY_CHOICES_KEY, {});
		return {
			family: stored.family ?? null,
			members: stored.members ?? {},
			displays: stored.displays ?? {},
		};
	};

	/** What Today hides for a caller: a display's own → the member's own → the family's. */
	async function effectiveHidden(db: DbExecutor, actor: Actor | undefined) {
		const choices = await readHidden(db);
		const familyHidden = hiddenOf(choices.family) ?? [];
		let myHidden: string[] | null = null;
		let own: string[] | null = null;
		if (actor?.kind === 'display') own = hiddenOf(choices.displays[actor.deviceId]);
		else if (actor?.kind === 'member') own = myHidden = hiddenOf(choices.members[actor.memberId]);
		return { hidden: own ?? familyHidden, familyHidden, myHidden };
	}

	/** The rotations of displays that are still paired; one that is revoked or not a screen is dropped. */
	async function readRotations(db: DbExecutor): Promise<Record<string, Rotation>> {
		const stored = await readJson<{ displays?: Record<string, unknown> }>(db, PAGES_KEY, {});
		const active = new Set(
			(
				await db
					.withTables<CoreTables>()
					.selectFrom('core_devices')
					.select('id')
					.where('kind', '=', 'kiosk')
					.where('revoked_at', 'is', null)
					.execute()
			).map((row) => row.id),
		);
		const out: Record<string, Rotation> = {};
		for (const [deviceId, value] of Object.entries(stored.displays ?? {})) {
			const parsed = RotationSchema.safeParse(value);
			if (active.has(deviceId) && parsed.success) out[deviceId] = parsed.data;
		}
		return out;
	}

	/** What a caller sees: a display its own theme, a member theirs, everyone else the family's. */
	async function effective(db: DbExecutor, actor: Actor | undefined) {
		const choices = await readChoices(db);
		const family = firstKnown(choices.family);
		let mine: string | null = null;
		let own: string | undefined;
		if (actor?.kind === 'display') own = choices.displays[actor.deviceId];
		else if (actor?.kind === 'member') {
			mine = choices.members[actor.memberId] ?? null;
			if (mine && !deps.themes().has(mine)) mine = null;
			own = mine ?? undefined;
		}
		const theme = firstKnown(own, choices.family);
		const version = theme
			? (deps
					.themes()
					.list()
					.find((t) => t.id === theme)?.version ?? null)
			: null;
		return {
			theme,
			version,
			family,
			mine,
			...(await effectiveStyle(db, actor, theme)),
			...(await effectiveHidden(db, actor)),
		};
	}

	const list = defineRoute({
		method: 'get',
		path: '/themes',
		operationId: 'core.listThemes',
		summary: 'The themes that can be chosen',
		// Needed before sign-in: the sign-in page already wears the family's theme.
		requires: 'public',
		response: z.array(ThemeSchema),
		async handle(ctx) {
			const installed = await readJson<InstalledMap>(ctx.db, INSTALLED_KEY, {});
			return deps
				.themes()
				.list()
				.map((t) => view(t, installed));
		},
	});

	const appearance = defineRoute({
		method: 'get',
		path: '/appearance',
		operationId: 'core.getAppearance',
		summary: 'Which theme and style apply to the caller: their own choice, else the family default',
		requires: 'public',
		response: AppearanceSchema,
		async handle(ctx, { actor }) {
			return effective(ctx.db, actor);
		},
	});

	const stylesheet = defineRoute({
		method: 'get',
		path: '/themes/{id}/stylesheet.css',
		operationId: 'core.getThemeStylesheet',
		summary: 'A theme as a stylesheet of custom properties, generated from its validated tokens',
		requires: 'public',
		params: z.object({ id: ThemeIdSchema }),
		response: TextResponseSchema,
		async handle(_ctx, { params }) {
			const sheet = deps.themes().stylesheet(params.id);
			if (!sheet) throw new FamosError('not_found', 'No such theme');
			return {
				text: sheet.css,
				contentType: 'text/css',
				// Revalidated with the ETag (the version changes with the content), so an updated pack shows at once.
				cacheControl: 'public, max-age=0, must-revalidate',
				etag: `"${sheet.version}"`,
			};
		},
	});

	const font = defineRoute({
		method: 'get',
		path: '/themes/{id}/fonts/{file}',
		operationId: 'core.getThemeFont',
		summary: "A font file of a theme's own pack",
		requires: 'public',
		params: z.object({
			id: ThemeIdSchema,
			file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,78}\.woff2$/),
		}),
		response: FileResponseSchema,
		async handle(_ctx, { params }) {
			const found = deps.themes().font(params.id, params.file);
			if (!found) throw new FamosError('not_found', 'No such font');
			return {
				stream: found.stream,
				size: found.size,
				contentType: 'font/woff2',
				filename: params.file,
				// The file name is part of the pack; a changed pack is a new version of the stylesheet that names it.
				cacheControl: 'public, max-age=86400',
			};
		},
	});

	const fetchState = defineRoute({
		method: 'get',
		path: '/themes/fetch',
		operationId: 'core.getThemeFetch',
		summary: 'How the last install of a theme pack from an address went',
		requires: CORE_CAPABILITIES.settingsManage.id,
		response: FetchStateSchema.nullable(),
		async handle(ctx) {
			return readJson<FetchState | null>(ctx.db, FETCH_KEY, null);
		},
	});

	const displayChoices = defineRoute({
		method: 'get',
		path: '/themes/displays',
		operationId: 'core.listDisplayThemes',
		summary: 'The theme chosen for each display (display id → theme id)',
		requires: CORE_CAPABILITIES.devicesManage.id,
		response: z.record(z.string(), z.string()),
		async handle(ctx) {
			return (await readChoices(ctx.db)).displays;
		},
	});

	const displayStyles = defineRoute({
		method: 'get',
		path: '/styles/displays',
		operationId: 'core.listDisplayStyles',
		summary: 'The style chosen for each display (display id → style id)',
		requires: CORE_CAPABILITIES.devicesManage.id,
		response: z.record(z.string(), StyleIdSchema),
		async handle(ctx) {
			const { displays } = await readStyleChoices(ctx.db);
			const known: Record<string, StyleId> = {};
			for (const [deviceId, id] of Object.entries(displays)) if (isStyle(id)) known[deviceId] = id;
			return known;
		},
	});

	const displayHidden = defineRoute({
		method: 'get',
		path: '/today/displays',
		operationId: 'core.listDisplayTodayBlocks',
		summary: "What each display's Today hides (display id → block ids); missing follows the family",
		requires: CORE_CAPABILITIES.devicesManage.id,
		response: z.record(z.string(), z.array(z.string())),
		async handle(ctx) {
			const { displays } = await readHidden(ctx.db);
			const out: Record<string, string[]> = {};
			for (const [deviceId, value] of Object.entries(displays)) {
				const hidden = hiddenOf(value);
				if (hidden) out[deviceId] = hidden;
			}
			return out;
		},
	});

	const displayPages = defineRoute({
		method: 'get',
		path: '/displays/pages',
		operationId: 'core.listDisplayPages',
		summary: "The pages each display shows between Today's turns (display id → rotation)",
		requires: CORE_CAPABILITIES.devicesManage.id,
		response: z.object({ displays: z.record(z.string(), RotationSchema) }),
		async handle(ctx) {
			return { displays: await readRotations(ctx.db) };
		},
	});

	const install = defineAction({
		id: 'core.installThemePack',
		title: 'Install or update a theme pack',
		input: z.object({
			pack: ThemePackInputSchema,
			/** Where the pack came from, when it was fetched from an address. */
			url: z.string().max(2000).optional(),
		}),
		output: z.object({ theme: ThemeSchema, warnings: z.array(z.string()) }),
		requires: CORE_CAPABILITIES.settingsManage.id,
		approval: 'never',
		// Writing the pack's files is the action's one effect outside the database. It is idempotent
		// (the same pack gives the same folder) and the install record below commits with it.
		async run(uow, input) {
			const { theme, warnings } = await deps.themes().install(input.pack);
			const installed = await readJson<InstalledMap>(uow.db, INSTALLED_KEY, {});
			installed[theme.id] = { installedAt: uow.clock.now(), url: input.url ?? null };
			await writeJson(uow.db, INSTALLED_KEY, installed, uow.clock.now());
			uow.emit(themesChanged, { id: theme.id });
			return { theme: view(theme, installed), warnings: warnings.slice(0, 50) };
		},
	});

	const remove = defineAction({
		id: 'core.removeThemePack',
		title: 'Remove an installed theme pack',
		input: z.object({ id: ThemeIdSchema }),
		output: z.object({ id: z.string() }),
		requires: CORE_CAPABILITIES.settingsManage.id,
		approval: 'never',
		async run(uow, input) {
			const installed = await readJson<InstalledMap>(uow.db, INSTALLED_KEY, {});
			if (!installed[input.id]) throw new FamosError('not_found', 'That pack is not installed');
			await deps.themes().remove(input.id);
			delete installed[input.id];
			await writeJson(uow.db, INSTALLED_KEY, installed, uow.clock.now());
			// Whoever used the theme falls back (the family to the default, people to the family's);
			// a bundled pack of the same id is still there, so only a removed id is cleaned up.
			if (!deps.themes().has(input.id)) {
				const choices = await readChoices(uow.db);
				const drop = (map: Record<string, string>) =>
					Object.fromEntries(Object.entries(map).filter(([, id]) => id !== input.id));
				await writeJson(
					uow.db,
					CHOICES_KEY,
					{
						family: choices.family === input.id ? null : choices.family,
						members: drop(choices.members),
						displays: drop(choices.displays),
					} satisfies Choices,
					uow.clock.now(),
				);
			}
			uow.emit(themesChanged, { id: input.id });
			return { id: input.id };
		},
	});

	const installFromUrl = defineAction({
		id: 'core.installThemePackFromUrl',
		title: 'Install a theme pack from an address',
		input: z.object({ url: z.url().max(2000) }),
		output: z.object({ queued: z.literal(true) }),
		requires: CORE_CAPABILITIES.settingsManage.id,
		approval: 'never',
		async run(uow, input) {
			if (new URL(input.url).protocol !== 'https:')
				throw new FamosError('bad_request', 'Only https addresses are allowed');
			await writeJson(
				uow.db,
				FETCH_KEY,
				{
					status: 'fetching',
					url: input.url,
					error: null,
					at: uow.clock.now(),
				} satisfies FetchState,
				uow.clock.now(),
			);
			// The fetch is network I/O, so it runs as a job (the guarded HTTP port is for jobs).
			await uow.enqueue(FETCH_THEME_JOB, { url: input.url });
			uow.emit(themesChanged, { id: null });
			return { queued: true as const };
		},
	});

	const fetchPack = defineJob({
		name: FETCH_THEME_JOB,
		payload: z.object({ url: z.string() }),
		maxAttempts: 2,
		timeoutMs: 60_000,
		async handle(ctx, payload) {
			const done = (state: Omit<FetchState, 'at' | 'url'>) =>
				writeJson(
					ctx.db,
					FETCH_KEY,
					{ ...state, url: payload.url, at: ctx.clock.now() },
					ctx.clock.now(),
				).then(() => ctx.events.emit(themesChanged, { id: null }));
			let text: string;
			try {
				const res = await ctx.http.get({ url: payload.url, maxBytes: MAX_PACK_URL_BYTES });
				if (res.status !== 200) throw new Error('unexpected answer');
				text = res.text;
			} catch {
				await done({ status: 'failed', error: 'The address could not be fetched' });
				return;
			}
			let pack: unknown;
			try {
				pack = JSON.parse(text);
			} catch {
				await done({ status: 'failed', error: 'The address did not return a theme pack' });
				return;
			}
			const parsed = ThemePackInputSchema.safeParse(pack);
			if (!parsed.success) {
				await done({ status: 'failed', error: 'The address did not return a theme pack' });
				return;
			}
			try {
				const result = await ctx.actions.invoke(
					'core.installThemePack',
					{ pack: parsed.data, url: payload.url },
					systemActor('core.themes'),
				);
				if (result.status === 'applied') await done({ status: 'done', error: null });
				else await done({ status: 'failed', error: 'The pack was refused' });
			} catch (error) {
				// A pack that fails validation is final: say why, and do not retry.
				const reason = isFamosError(error) ? `: ${error.message}` : '';
				await done({ status: 'failed', error: `The pack was refused${reason}`.slice(0, 500) });
			}
		},
	});

	const assertKnown = (id: string) => {
		if (!deps.themes().has(id))
			throw new FamosError('bad_request', `The theme "${id}" is not available`);
	};

	const setFamilyTheme = defineAction({
		id: 'core.setFamilyTheme',
		title: "Choose the family's default theme",
		input: z.object({ theme: ThemeIdSchema }),
		output: z.object({ theme: z.string() }),
		requires: CORE_CAPABILITIES.settingsManage.id,
		approval: 'never',
		async run(uow, input) {
			assertKnown(input.theme);
			const choices = await readChoices(uow.db);
			await writeJson(uow.db, CHOICES_KEY, { ...choices, family: input.theme }, uow.clock.now());
			uow.emit(themesChanged, { id: input.theme });
			return { theme: input.theme };
		},
	});

	const setMyTheme = defineAction({
		id: 'core.setMyTheme',
		title: 'Choose my own theme',
		input: z.object({ theme: ThemeIdSchema.nullable() }),
		output: z.object({ theme: z.string().nullable() }),
		// Everyone may choose how the app looks to them; it changes nothing for anyone else.
		requires: CORE_CAPABILITIES.notificationsReceive.id,
		approval: 'never',
		async run(uow, input) {
			if (uow.actor.kind !== 'member')
				throw new FamosError('bad_request', 'Only a person can choose a theme for themselves');
			if (input.theme) assertKnown(input.theme);
			const choices = await readChoices(uow.db);
			const members = { ...choices.members };
			if (input.theme) members[uow.actor.memberId] = input.theme;
			else delete members[uow.actor.memberId];
			await writeJson(uow.db, CHOICES_KEY, { ...choices, members }, uow.clock.now());
			uow.emit(themesChanged, { id: input.theme });
			return { theme: input.theme };
		},
	});

	const setDisplayTheme = defineAction({
		id: 'core.setDisplayTheme',
		title: 'Choose the theme of a display',
		input: z.object({ deviceId: z.string().max(80), theme: ThemeIdSchema.nullable() }),
		output: z.object({ deviceId: z.string(), theme: z.string().nullable() }),
		requires: CORE_CAPABILITIES.devicesManage.id,
		approval: 'never',
		async run(uow, input) {
			if (input.theme) assertKnown(input.theme);
			const device = await uow.db
				.withTables<CoreTables>()
				.selectFrom('core_devices')
				.select('kind')
				.where('id', '=', input.deviceId)
				.executeTakeFirst();
			if (device?.kind !== 'kiosk') throw new FamosError('not_found', 'No such display');
			const choices = await readChoices(uow.db);
			const displays = { ...choices.displays };
			if (input.theme) displays[input.deviceId] = input.theme;
			else delete displays[input.deviceId];
			await writeJson(uow.db, CHOICES_KEY, { ...choices, displays }, uow.clock.now());
			uow.emit(themesChanged, { id: input.theme });
			return { deviceId: input.deviceId, theme: input.theme };
		},
	});

	const setFamilyStyle = defineAction({
		id: 'core.setFamilyStyle',
		title: "Choose the family's default style",
		input: z.object({ style: StyleIdSchema }),
		output: z.object({ style: StyleIdSchema }),
		requires: CORE_CAPABILITIES.settingsManage.id,
		approval: 'never',
		async run(uow, input) {
			const choices = await readStyleChoices(uow.db);
			await writeJson(
				uow.db,
				STYLE_CHOICES_KEY,
				{ ...choices, family: input.style },
				uow.clock.now(),
			);
			uow.emit(themesChanged, { id: null });
			return { style: input.style };
		},
	});

	const setMyStyle = defineAction({
		id: 'core.setMyStyle',
		title: 'Choose my own style',
		input: z.object({ style: StyleIdSchema.nullable() }),
		output: z.object({ style: StyleIdSchema.nullable() }),
		// Everyone may choose how the app looks to them; it changes nothing for anyone else.
		requires: CORE_CAPABILITIES.notificationsReceive.id,
		approval: 'never',
		async run(uow, input) {
			if (uow.actor.kind !== 'member')
				throw new FamosError('bad_request', 'Only a person can choose a style for themselves');
			const choices = await readStyleChoices(uow.db);
			const members = { ...choices.members };
			if (input.style) members[uow.actor.memberId] = input.style;
			else delete members[uow.actor.memberId];
			await writeJson(uow.db, STYLE_CHOICES_KEY, { ...choices, members }, uow.clock.now());
			uow.emit(themesChanged, { id: null });
			return { style: input.style };
		},
	});

	const setDisplayStyle = defineAction({
		id: 'core.setDisplayStyle',
		title: 'Choose the style of a display',
		input: z.object({ deviceId: z.string().max(80), style: StyleIdSchema.nullable() }),
		output: z.object({ deviceId: z.string(), style: StyleIdSchema.nullable() }),
		requires: CORE_CAPABILITIES.devicesManage.id,
		approval: 'never',
		async run(uow, input) {
			const device = await uow.db
				.withTables<CoreTables>()
				.selectFrom('core_devices')
				.select('kind')
				.where('id', '=', input.deviceId)
				.executeTakeFirst();
			if (device?.kind !== 'kiosk') throw new FamosError('not_found', 'No such display');
			const choices = await readStyleChoices(uow.db);
			const displays = { ...choices.displays };
			if (input.style) displays[input.deviceId] = input.style;
			else delete displays[input.deviceId];
			await writeJson(uow.db, STYLE_CHOICES_KEY, { ...choices, displays }, uow.clock.now());
			uow.emit(themesChanged, { id: null });
			return { deviceId: input.deviceId, style: input.style };
		},
	});

	const setFamilyTodayBlocks = defineAction({
		id: 'core.setFamilyTodayBlocks',
		title: "Choose what the family's Today shows",
		input: z.object({ hidden: HiddenBlocksSchema }),
		output: z.object({ hidden: z.array(z.string()) }),
		requires: CORE_CAPABILITIES.settingsManage.id,
		approval: 'never',
		async run(uow, input) {
			const hidden = hiddenOf(input.hidden) ?? [];
			const choices = await readHidden(uow.db);
			await writeJson(uow.db, TODAY_CHOICES_KEY, { ...choices, family: hidden }, uow.clock.now());
			uow.emit(themesChanged, { id: null });
			return { hidden };
		},
	});

	const setMyTodayBlocks = defineAction({
		id: 'core.setMyTodayBlocks',
		title: 'Choose what my Today shows',
		input: z.object({ hidden: HiddenBlocksSchema.nullable() }),
		output: z.object({ hidden: z.array(z.string()).nullable() }),
		// Everyone may choose what their own Today shows; it changes nothing for anyone else.
		requires: CORE_CAPABILITIES.notificationsReceive.id,
		approval: 'never',
		async run(uow, input) {
			if (uow.actor.kind !== 'member')
				throw new FamosError('bad_request', 'Only a person can choose what their Today shows');
			const hidden = input.hidden ? (hiddenOf(input.hidden) ?? []) : null;
			const choices = await readHidden(uow.db);
			const members = { ...choices.members };
			if (hidden) members[uow.actor.memberId] = hidden;
			else delete members[uow.actor.memberId];
			await writeJson(uow.db, TODAY_CHOICES_KEY, { ...choices, members }, uow.clock.now());
			uow.emit(themesChanged, { id: null });
			return { hidden };
		},
	});

	const setDisplayTodayBlocks = defineAction({
		id: 'core.setDisplayTodayBlocks',
		title: "Choose what a display's Today shows",
		input: z.object({ deviceId: z.string().max(80), hidden: HiddenBlocksSchema.nullable() }),
		output: z.object({ deviceId: z.string(), hidden: z.array(z.string()).nullable() }),
		requires: CORE_CAPABILITIES.devicesManage.id,
		approval: 'never',
		async run(uow, input) {
			const device = await uow.db
				.withTables<CoreTables>()
				.selectFrom('core_devices')
				.select('kind')
				.where('id', '=', input.deviceId)
				.executeTakeFirst();
			if (device?.kind !== 'kiosk') throw new FamosError('not_found', 'No such display');
			const hidden = input.hidden ? (hiddenOf(input.hidden) ?? []) : null;
			const choices = await readHidden(uow.db);
			const displays = { ...choices.displays };
			if (hidden) displays[input.deviceId] = hidden;
			else delete displays[input.deviceId];
			await writeJson(uow.db, TODAY_CHOICES_KEY, { ...choices, displays }, uow.clock.now());
			uow.emit(themesChanged, { id: null });
			return { deviceId: input.deviceId, hidden };
		},
	});

	const setDisplayPages = defineAction({
		id: 'core.setDisplayPages',
		title: 'Choose the pages a display shows between the turns of Today',
		input: z.object({ deviceId: z.string().max(80), rotation: RotationSchema.nullable() }),
		output: z.object({ deviceId: z.string(), rotation: RotationSchema.nullable() }),
		requires: CORE_CAPABILITIES.devicesManage.id,
		approval: 'never',
		async run(uow, input) {
			const device = await uow.db
				.withTables<CoreTables>()
				.selectFrom('core_devices')
				.select(['kind', 'revoked_at'])
				.where('id', '=', input.deviceId)
				.executeTakeFirst();
			if (device?.kind !== 'kiosk' || device.revoked_at !== null)
				throw new FamosError('not_found', 'No such display');
			// Entries of displays that were removed since are dropped with this write.
			const displays = await readRotations(uow.db);
			if (input.rotation) displays[input.deviceId] = input.rotation;
			else delete displays[input.deviceId];
			await writeJson(uow.db, PAGES_KEY, { displays }, uow.clock.now());
			uow.emit(themesChanged, { id: null });
			return { deviceId: input.deviceId, rotation: input.rotation };
		},
	});

	return {
		actions: [
			install,
			remove,
			installFromUrl,
			setFamilyTheme,
			setMyTheme,
			setDisplayTheme,
			setFamilyStyle,
			setMyStyle,
			setDisplayStyle,
			setFamilyTodayBlocks,
			setMyTodayBlocks,
			setDisplayTodayBlocks,
			setDisplayPages,
		],
		routes: [
			list,
			appearance,
			fetchState,
			displayChoices,
			displayStyles,
			displayHidden,
			displayPages,
			stylesheet,
			font,
		],
		jobs: [fetchPack],
		events: [themesChanged],
		/**
		 * The theme, style and hidden Today blocks that apply to a caller (a display's own, a
		 * member's, the family's).
		 */
		effective,
		/** The pages a paired display shows between Today's turns; null shows only Today. */
		async rotationOf(db: DbExecutor, deviceId: string): Promise<Rotation | null> {
			return (await readRotations(db))[deviceId] ?? null;
		},
	};
}

export type Themes = ReturnType<typeof createThemes>;
