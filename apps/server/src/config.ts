import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type ProviderInput, ProviderKindSchema } from '@famos/adapters/llm-aisdk';
import type { ModelRole } from '@famos/sdk';
import { z } from 'zod';

const EnvSchema = z.object({
	FAMOS_DATA_DIR: z.string().default('./data'),
	FAMOS_WEB_DIR: z.string().optional(),
	/** Bundled language packs; found next to the server bundle when not set. */
	FAMOS_LANGUAGES_DIR: z.string().optional(),
	/** Bundled theme packs; found next to the server bundle when not set. */
	FAMOS_THEMES_DIR: z.string().optional(),
	PORT: z.coerce.number().int().min(1).max(65535).default(3000),
	HOST: z.string().default('0.0.0.0'),
	FAMOS_BASE_URL: z.url().optional(),
	FAMOS_TRUSTED_ORIGINS: z.string().optional(),
	FAMOS_SECRET: z.string().min(32).optional(),
	/** First-run setup code; generated into the data directory when not set. */
	FAMOS_SETUP_CODE: z.string().min(8).max(100).optional(),
	/** Reverse proxies (IPs or CIDRs, comma separated) whose X-Forwarded-For is believed. */
	FAMOS_TRUSTED_PROXIES: z.string().optional(),
	FAMOS_ROLES: z.string().default('api,worker'),
	FAMOS_BACKUP_HOUR: z.coerce.number().int().min(0).max(23).default(3),
	FAMOS_BACKUP_KEEP: z.coerce.number().int().min(1).max(365).default(7),
	// An AI provider and models from the server configuration, applied on every start.
	FAMOS_AI_PROVIDER: ProviderKindSchema.optional(),
	FAMOS_AI_BASE_URL: z.url().optional(),
	FAMOS_AI_API_KEY: z.string().min(1).optional(),
	/** Model for every role, unless a role-specific variable is set. */
	FAMOS_AI_MODEL: z.string().min(1).optional(),
	FAMOS_AI_MODEL_FAST: z.string().min(1).optional(),
	FAMOS_AI_MODEL_VISION: z.string().min(1).optional(),
	FAMOS_AI_MODEL_SMART: z.string().min(1).optional(),
	/** For testing: where the Telegram Bot API lives (default https://api.telegram.org). */
	FAMOS_TELEGRAM_API_ROOT: z.url().optional(),
	/**
	 * For testing: where the extension index is (default the official one). Its signature is
	 * still checked against the server's own trust roots, so this adds no source of code.
	 */
	FAMOS_EXTENSION_INDEX_URL: z.url({ protocol: /^https$/ }).optional(),
	/** For testing only: a directory of .eml files stands in for the IMAP server. */
	FAMOS_EMAIL_FAKE_DIR: z.string().min(1).optional(),
	/** For testing only: how long a suggestion waits before it notifies approvers (ms). */
	FAMOS_NOTIFY_DELAY_MS: z.coerce.number().int().min(0).optional(),
	LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export interface Config {
	dataDir: string;
	dbPath: string;
	filesDir: string;
	backupsDir: string;
	/** Language packs an admin installed (`<data>/languages`), included in backups. */
	languagesDir: string;
	/** Language packs shipped with the app. */
	bundledLanguagesDir: string | undefined;
	/** Theme packs an admin installed (`<data>/themes`), included in backups. */
	themesDir: string;
	/** Extension packages installed from signed files (`<data>/extensions`), included in backups. */
	extensionsDir: string;
	/** Theme packs shipped with the app. */
	bundledThemesDir: string | undefined;
	webDir: string | undefined;
	port: number;
	host: string;
	baseURL: string;
	/** `FAMOS_BASE_URL` as the admin set it; unset when the base URL is only the local default. */
	publicURL?: string;
	trustedOrigins: string[];
	trustedProxies: string[];
	secret: string;
	/** Required to complete first-run setup. */
	setupCode: string;
	roles: { api: boolean; worker: boolean };
	backup: { hour: number; keep: number };
	logLevel: string;
	/** For testing: where the extension index is. Unset means the official one. */
	extensionIndexUrl?: string;
	/** For testing: where the Telegram Bot API lives. Unset means api.telegram.org. */
	telegramApiRoot?: string;
	/** For testing only: a directory of .eml files that stands in for the IMAP server. */
	emailFakeDir?: string;
	/** For testing only: milliseconds a suggestion waits before it notifies (default 30000). */
	notifyDelayMs?: number;
	aiSeed?: ProviderInput & { models: Partial<Record<ModelRole, string>> };
}

/**
 * Reads configuration from the environment. If FAMOS_SECRET is not set, a random secret is
 * generated once and stored in the data directory (mode 0600), so a plain `docker compose up`
 * works without any configuration.
 */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
	const e = EnvSchema.parse(env);
	const dataDir = resolve(e.FAMOS_DATA_DIR);
	await mkdir(dataDir, { recursive: true });
	const baseURL = (e.FAMOS_BASE_URL ?? `http://localhost:${e.PORT}`).replace(/\/+$/, '');
	const roles = new Set(e.FAMOS_ROLES.split(',').map((r) => r.trim()));
	return {
		dataDir,
		dbPath: join(dataDir, 'famos.db'),
		filesDir: join(dataDir, 'files'),
		backupsDir: join(dataDir, 'backups'),
		languagesDir: join(dataDir, 'languages'),
		bundledLanguagesDir: e.FAMOS_LANGUAGES_DIR ? resolve(e.FAMOS_LANGUAGES_DIR) : undefined,
		themesDir: join(dataDir, 'themes'),
		extensionsDir: join(dataDir, 'extensions'),
		bundledThemesDir: e.FAMOS_THEMES_DIR ? resolve(e.FAMOS_THEMES_DIR) : undefined,
		webDir: e.FAMOS_WEB_DIR ? resolve(e.FAMOS_WEB_DIR) : undefined,
		port: e.PORT,
		host: e.HOST,
		baseURL,
		...(e.FAMOS_BASE_URL && { publicURL: baseURL }),
		trustedOrigins: [
			baseURL,
			...(e.FAMOS_TRUSTED_ORIGINS?.split(',')
				.map((o) => o.trim())
				.filter(Boolean) ?? []),
		],
		trustedProxies:
			e.FAMOS_TRUSTED_PROXIES?.split(',')
				.map((p) => p.trim())
				.filter(Boolean) ?? [],
		secret: e.FAMOS_SECRET ?? (await persistedSecret(dataDir)),
		setupCode: e.FAMOS_SETUP_CODE ?? (await persistedSecret(dataDir, 'setup-code', 9)),
		roles: { api: roles.has('api'), worker: roles.has('worker') },
		backup: { hour: e.FAMOS_BACKUP_HOUR, keep: e.FAMOS_BACKUP_KEEP },
		logLevel: e.LOG_LEVEL,
		...(e.FAMOS_TELEGRAM_API_ROOT && { telegramApiRoot: e.FAMOS_TELEGRAM_API_ROOT }),
		...(e.FAMOS_EXTENSION_INDEX_URL && { extensionIndexUrl: e.FAMOS_EXTENSION_INDEX_URL }),
		...(e.FAMOS_EMAIL_FAKE_DIR && { emailFakeDir: e.FAMOS_EMAIL_FAKE_DIR }),
		...(e.FAMOS_NOTIFY_DELAY_MS !== undefined && { notifyDelayMs: e.FAMOS_NOTIFY_DELAY_MS }),
		...(e.FAMOS_AI_PROVIDER && {
			aiSeed: {
				name: { openrouter: 'OpenRouter', ollama: 'Ollama', 'openai-compatible': 'AI server' }[
					e.FAMOS_AI_PROVIDER
				],
				kind: e.FAMOS_AI_PROVIDER,
				...(e.FAMOS_AI_BASE_URL && { baseUrl: e.FAMOS_AI_BASE_URL }),
				...(e.FAMOS_AI_API_KEY && { apiKey: e.FAMOS_AI_API_KEY }),
				models: Object.fromEntries(
					(
						[
							['fast', e.FAMOS_AI_MODEL_FAST],
							['vision', e.FAMOS_AI_MODEL_VISION],
							['smart', e.FAMOS_AI_MODEL_SMART],
						] as const
					)
						.map(([role, model]) => [role, model ?? e.FAMOS_AI_MODEL])
						.filter(([, model]) => model),
				),
			},
		}),
	};
}

/** A random value stored once in the data directory (mode 0600) and reused on every start. */
async function persistedSecret(dataDir: string, name = 'secret', bytes = 32): Promise<string> {
	const path = join(dataDir, name);
	const minLength = Math.ceil((bytes * 4) / 3);
	try {
		const existing = (await readFile(path, 'utf8')).trim();
		if (existing.length >= minLength) return existing;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	const secret = randomBytes(bytes).toString('base64url');
	await writeFile(path, `${secret}\n`, { mode: 0o600 });
	await chmod(path, 0o600);
	return secret;
}
