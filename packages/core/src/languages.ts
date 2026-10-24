import {
	type DbExecutor,
	defineAction,
	defineEvent,
	defineRoute,
	EVERYONE,
	FamosError,
	TextResponseSchema,
} from '@famos/sdk';
import { isFormatLocale } from '@famos/time';
import { z } from 'zod';
import { CORE_CAPABILITIES } from './core-capabilities.ts';
import { LanguageCodeSchema, readFamilySettings, writeFamilySettings } from './family.ts';
import { createPackInstaller } from './pack-installer.ts';
import { readJson, writeJson } from './settings-json.ts';
import type { CoreTables } from './tables.ts';

/**
 * Languages. Core knows no language by name: a language code is any valid BCP 47 tag
 * that a pack exists for. The packs themselves (files, validation, merging with English) live
 * in the composition root behind `LanguagePort`; core only validates codes against it, stores
 * which packs were installed, and offers the actions and routes around it.
 */

export const LanguageSchema = z.object({
	code: z.string(),
	/** In English ("Turkish"). */
	name: z.string(),
	/** In the language itself ("Türkçe"). */
	nativeName: z.string(),
	dir: z.enum(['ltr', 'rtl']),
	version: z.string(),
	/** `base`: English, which the code carries; `bundled`: shipped with the app; `installed`: added by an admin. */
	source: z.enum(['base', 'bundled', 'installed']),
	/** Share of English strings the pack translates, 0 to 1. */
	coverage: z.number(),
	/** An installed pack that replaces a bundled one of the same code. */
	overridesBundled: z.boolean(),
	installedAt: z.number().nullable(),
	/** Where an installed pack was fetched from, when it was fetched. */
	url: z.string().nullable(),
});
export type Language = z.infer<typeof LanguageSchema>;

/** The port's own view of a pack (no install record). */
export type LanguageSummary = Omit<Language, 'installedAt' | 'url'>;

export interface LanguageProblem {
	namespace: string;
	key: string;
	kind: 'unknown_key' | 'not_text' | 'placeholders' | 'too_long';
}

export interface LanguageCatalogs {
	code: string;
	/** Changes when the pack's content changes: the cache key and ETag. */
	version: string;
	dir: 'ltr' | 'rtl';
	catalogs: Record<string, unknown>;
}

/** What core needs from the language registry the composition root builds. */
export interface LanguagePort {
	list(): LanguageSummary[];
	/** Whether a language with this code can be chosen. English always can. */
	has(code: string): boolean;
	/** A pack's catalogs; null for English (the app carries it) and for unknown codes. */
	catalogs(code: string): LanguageCatalogs | null;
	/** Validates and stores an installed pack. Throws `FamosError('bad_request')` for a bad pack. */
	install(pack: unknown): Promise<{ language: LanguageSummary; problems: LanguageProblem[] }>;
	/** Removes an installed pack (a bundled one is only un-overridden). Throws when nothing is installed. */
	remove(code: string): Promise<void>;
}

/** Without a registry (tests): English is listed and any well-formed code may be chosen. */
export const anyLanguage: LanguagePort = {
	list: () => [
		{
			code: 'en',
			name: 'English',
			nativeName: 'English',
			dir: 'ltr',
			version: '1.0.0',
			source: 'base',
			coverage: 1,
			overridesBundled: false,
		},
	],
	has: (code) => isFormatLocale(code),
	catalogs: () => null,
	install: () => Promise.reject(new FamosError('bad_request', 'Language packs are not available')),
	remove: () => Promise.reject(new FamosError('not_found', 'Language packs are not available')),
};

export const languagesChanged = defineEvent(
	'core.languages.changed',
	z.object({ code: z.string().nullable() }),
	{ audience: EVERYONE },
);
/** Family settings (language, region formats, time zone) changed: open screens refresh them. */
export const familySettingsChanged = defineEvent('core.family.changed', z.object({}), {
	audience: EVERYONE,
});

const KEY = 'languages';
const FETCH_KEY = 'languages.fetch';
export const FETCH_JOB = 'core.fetchLanguagePack';

interface InstalledRecord {
	installedAt: number;
	url: string | null;
}
type InstalledMap = Record<string, InstalledRecord>;

const settings = (db: DbExecutor) => db.withTables<CoreTables>();

const PackInputSchema = z.object({
	manifest: z.record(z.string(), z.unknown()),
	catalogs: z.record(z.string(), z.unknown()),
});

const MAX_REPORTED = 100;
const MAX_PACK_URL_BYTES = 2 * 1024 * 1024;

export interface LanguagesDeps {
	languages: () => LanguagePort;
}

export function createLanguages(deps: LanguagesDeps) {
	const view = (summary: LanguageSummary, installed: InstalledMap): Language => ({
		...summary,
		installedAt: installed[summary.code]?.installedAt ?? null,
		url: installed[summary.code]?.url ?? null,
	});

	const list = defineRoute({
		method: 'get',
		path: '/languages',
		operationId: 'core.listLanguages',
		summary: 'The languages that can be chosen, with how much of the app each translates',
		// Needed before setup and sign-in: the first screen is the language choice.
		requires: 'public',
		response: z.array(LanguageSchema),
		async handle(ctx) {
			const installed = await readJson<InstalledMap>(ctx.db, KEY, {});
			return deps
				.languages()
				.list()
				.map((l) => view(l, installed));
		},
	});

	const catalogs = defineRoute({
		method: 'get',
		path: '/languages/{code}/catalogs',
		operationId: 'core.getLanguageCatalogs',
		summary: 'A language pack as JSON ({ code, version, dir, catalogs }); English is not served',
		requires: 'public',
		params: z.object({ code: z.string().max(35) }),
		// JSON text, cacheable by version: the browser revalidates with the ETag.
		response: TextResponseSchema,
		async handle(_ctx, { params }) {
			const pack = deps.languages().catalogs(params.code);
			if (!pack) throw new FamosError('not_found', 'No such language pack');
			return {
				text: JSON.stringify(pack),
				contentType: 'application/json',
				cacheControl: 'public, max-age=0, must-revalidate',
				etag: `"${pack.version}"`,
			};
		},
	});

	const install = defineAction({
		id: 'core.installLanguagePack',
		title: 'Install or update a language pack',
		input: z.object({
			pack: PackInputSchema,
			/** Where the pack came from, when it was fetched from an address. */
			url: z.string().max(2000).optional(),
		}),
		output: z.object({
			language: LanguageSchema,
			problems: z.array(
				z.object({
					namespace: z.string(),
					key: z.string(),
					kind: z.enum(['unknown_key', 'not_text', 'placeholders', 'too_long']),
				}),
			),
			/** Problems beyond the first hundred. */
			moreProblems: z.number().int(),
		}),
		requires: CORE_CAPABILITIES.settingsManage.id,
		approval: 'never',
		// Writing the pack's files is the action's one effect outside the database. It is idempotent
		// (the same pack gives the same folder) and the install record below commits with it.
		async run(uow, input) {
			const { language, problems } = await deps.languages().install(input.pack);
			const installed = await readJson<InstalledMap>(uow.db, KEY, {});
			installed[language.code] = { installedAt: uow.clock.now(), url: input.url ?? null };
			await writeJson(uow.db, KEY, installed, uow.clock.now());
			uow.emit(languagesChanged, { code: language.code });
			return {
				language: view(language, installed),
				problems: problems.slice(0, MAX_REPORTED),
				moreProblems: Math.max(0, problems.length - MAX_REPORTED),
			};
		},
	});

	const remove = defineAction({
		id: 'core.removeLanguagePack',
		title: 'Remove an installed language pack',
		input: z.object({ code: LanguageCodeSchema }),
		output: z.object({ code: z.string() }),
		requires: CORE_CAPABILITIES.settingsManage.id,
		approval: 'never',
		async run(uow, input) {
			const installed = await readJson<InstalledMap>(uow.db, KEY, {});
			if (!installed[input.code]) throw new FamosError('not_found', 'That pack is not installed');
			await deps.languages().remove(input.code);
			delete installed[input.code];
			await writeJson(uow.db, KEY, installed, uow.clock.now());
			// Whoever used the language falls back: the family to its default, people to the family's.
			// A bundled pack of the same code is still there; only a removed code is left behind.
			if (!deps.languages().has(input.code)) {
				const family = await readFamilySettings(uow.db);
				if (family.locale === input.code) {
					await writeFamilySettings(uow.db, { ...family, locale: 'en' }, uow.clock.now());
					uow.emit(familySettingsChanged, {});
				}
				await settings(uow.db)
					.updateTable('core_members')
					.set({ locale: null })
					.where('locale', '=', input.code)
					.execute();
			}
			uow.emit(languagesChanged, { code: input.code });
			return { code: input.code };
		},
	});

	const { fetchState, installFromUrl, fetchPack } = createPackInstaller({
		key: FETCH_KEY,
		job: FETCH_JOB,
		installActionId: 'core.installLanguagePack',
		schema: PackInputSchema,
		maxBytes: MAX_PACK_URL_BYTES,
		actionId: 'core.installLanguagePackFromUrl',
		actionTitle: 'Install a language pack from an address',
		actor: 'core.languages',
		route: {
			path: '/languages/fetch',
			operationId: 'core.getLanguageFetch',
			summary: 'How the last install of a language pack from an address went',
		},
		changed: { event: languagesChanged, key: 'code' },
	});

	return {
		actions: [install, remove, installFromUrl],
		routes: [list, fetchState, catalogs],
		jobs: [fetchPack],
		events: [languagesChanged, familySettingsChanged],
		/** Refuses a language code no pack exists for. */
		assertKnown(code: string): void {
			if (!deps.languages().has(code))
				throw new FamosError('bad_request', `The language "${code}" is not available`);
		},
	};
}

export type Languages = ReturnType<typeof createLanguages>;
