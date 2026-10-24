// Core cannot depend on @famos/testing (which depends on core), so its tests build the kernel
// here from the same real adapters. Extensions use createTestKernel from @famos/testing instead.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupMigrations, createBackupSettingsAdmin } from '@famos/adapters/backup';
import { createEmailSettingsAdmin, emailMigrations } from '@famos/adapters/email';
import { createFsFileStore } from '@famos/adapters/files-fs';
import {
	type AiSettingsService,
	aiMigrations,
	createAiSettings,
	createSecretBox,
} from '@famos/adapters/llm-aisdk';
import {
	createSqliteQueue,
	queueMigrations,
	type SqliteJobQueue,
} from '@famos/adapters/queue-sqlite';
import { silentLogger, uuidv7Ids } from '@famos/adapters/runtime';
import { createTelegramLinkAdmin, telegramMigrations } from '@famos/adapters/telegram';
import { openDatabase, runMigrations } from '@famos/db';
import {
	type Actor,
	BACKUP_RUN_JOB,
	defineExtension,
	defineJob,
	EMAIL_POLL_JOB,
	type ExtensionContext,
	type ExtensionDefinition,
	type ExtensionManifestInput,
	type ExternalHttp,
	ExternalHttpError,
	type IdentityAdmin,
	type JobContext,
	LlmError,
	type MemberId,
	type NotificationChannel,
	type NotificationChannelDefinition,
	type NotificationMessage,
	type RouteRequest,
	SDK_VERSION,
	systemActor,
} from '@famos/sdk';
import { z } from 'zod';
import type { Member } from '../src/core-extension.ts';
import type { ExtensionPackagesPort } from '../src/extension-state.ts';
import { createKernel, type Kernel } from '../src/kernel.ts';
import type { LanguagePort } from '../src/languages.ts';
import type { ThemePort } from '../src/themes.ts';
import type { WorkerOptions } from '../src/worker.ts';

export interface TestClock {
	now(): number;
	advance(ms: number): void;
}

export interface TestKernel extends Kernel {
	readonly clock: TestClock;
	readonly queue: SqliteJobQueue;
	readonly passwords: Map<string, string>;
	/** The AI settings service on the same database. */
	readonly ai: AiSettingsService;
	/** Creates a member with a role id (built-in or custom) and returns its Actor. */
	member(roleId?: string): Promise<{ actor: Actor & { kind: 'member' }; member: Member }>;
	/** Calls a route handler directly; omitted request fields get neutral defaults. */
	route(operationId: string): {
		// biome-ignore lint/suspicious/noExplicitAny: test helper over heterogeneous route responses.
		call(request?: Partial<RouteRequest<any, any, any>>): Promise<any>;
	};
	close(): Promise<void>;
}

export async function createTestKernel(
	options: {
		extensions?: ExtensionDefinition[];
		channels?: readonly NotificationChannel[];
		/** The family's public address, for absolute links. */
		publicUrl?: string;
		translate?: (locale: string, key: string, params?: Record<string, unknown>) => string;
		languages?: LanguagePort;
		themes?: ThemePort;
		draftNotifyDelayMs?: number;
		/** A database file, to open the same data with another kernel (default: in memory). */
		dbPath?: string;
		refusable?: readonly string[];
		extensionPackages?: ExtensionPackagesPort;
		/** Outbound HTTP (default: unreachable). */
		http?: ExternalHttp;
		worker?: WorkerOptions;
	} = {},
): Promise<TestKernel> {
	const handle = openDatabase({ path: options.dbPath ?? ':memory:' });
	let now = Date.UTC(2026, 0, 1, 9);
	const clock: TestClock = { now: () => now, advance: (ms) => (now += ms) };
	const passwords = new Map<string, string>();
	const pins = new Set<string>();
	const identity: IdentityAdmin = {
		setPasswordLogin: async ({ memberId, email }) => void passwords.set(memberId, email),
		setPin: async ({ memberId }) => void pins.add(memberId),
		signInMethods: async () =>
			new Map(
				[...new Set([...passwords.keys(), ...pins])].map((id) => [
					id,
					{ password: passwords.has(id), pin: pins.has(id) },
				]),
			),
		endSessions: async () => {},
		endDeviceSessions: async () => {},
		endAllSessions: async () => {},
		carryNewerLogins: async () => 0,
		revokeAll: async (memberId) => {
			passwords.delete(memberId);
			pins.delete(memberId);
		},
	};
	const queue = createSqliteQueue({ db: handle.db, clock, ids: uuidv7Ids });
	const ai = createAiSettings({
		db: handle.db,
		box: createSecretBox('core-test-secret'),
		clock,
		ids: uuidv7Ids,
		timeZone: async () => 'UTC',
	});
	const kernel = createKernel({
		db: handle.db,
		queue,
		clock,
		ids: uuidv7Ids,
		logger: silentLogger,
		files: createFsFileStore(await mkdtemp(join(tmpdir(), 'famos-core-'))),
		secrets: (extensionId) => ({
			seal: (plain) => `sealed:${extensionId}:${plain}`,
			open: (sealed) =>
				sealed.startsWith(`sealed:${extensionId}:`)
					? sealed.slice(`sealed:${extensionId}:`.length)
					: null,
		}),
		http: options.http ?? {
			get: async () => {
				throw new ExternalHttpError('unreachable', 'No network in core tests');
			},
			post: async () => {
				throw new ExternalHttpError('unreachable', 'No network in core tests');
			},
		},
		identity,
		// The adapters' own jobs are the server's to register; the actions only queue them by name.
		infrastructureJobs: [BACKUP_RUN_JOB, EMAIL_POLL_JOB].map((name) =>
			defineJob({ name, payload: z.object({}), lane: 'long', handle: async () => {} }),
		),
		aiSettings: ai,
		backupSettings: createBackupSettingsAdmin({
			box: createSecretBox('core-test-secret'),
			clock,
			logger: silentLogger,
		}),
		emailSettings: createEmailSettingsAdmin({ clock }),
		telegramLinks: createTelegramLinkAdmin(),
		llm: {
			generateObject: async () => {
				throw new LlmError('not_configured', 'No model in core tests');
			},
			chat: async () => {
				throw new LlmError('not_configured', 'No model in core tests');
			},
			transcribe: async () => {
				throw new LlmError('not_configured', 'No model in core tests');
			},
			embed: async () => {
				throw new LlmError('not_configured', 'No model in core tests');
			},
			policy: async () => ({
				enabled: true,
				sendFiles: true,
				sendPeople: true,
				sendVoice: true,
				local: false,
				model: null,
			}),
		},
		extensions: options.extensions ?? [],
		infrastructureMigrations: [
			{ scope: 'queue', migrations: queueMigrations },
			{ scope: 'ai', migrations: aiMigrations },
			{ scope: 'telegram', migrations: telegramMigrations },
			{ scope: 'email', migrations: emailMigrations },
			{ scope: 'backup', migrations: backupMigrations },
		],
		appVersion: '0.0.0-test',
		...(options.channels && { channels: options.channels }),
		...(options.publicUrl && { publicUrl: options.publicUrl }),
		...(options.translate && { translate: options.translate }),
		...(options.languages && { languages: options.languages }),
		...(options.themes && { themes: options.themes }),
		...(options.draftNotifyDelayMs !== undefined && {
			draftNotifyDelayMs: options.draftNotifyDelayMs,
		}),
		...(options.worker && { worker: options.worker }),
		...(options.refusable && { refusable: options.refusable }),
		...(options.extensionPackages && { extensionPackages: options.extensionPackages }),
	});
	await runMigrations(handle.db, kernel.migrationScopes, clock.now);
	await kernel.start();
	let n = 0;
	return {
		...kernel,
		clock,
		queue,
		passwords,
		ai,
		async member(roleId = 'admin') {
			const result = await kernel.runner.invoke<Member>(
				'core.createMember',
				{ displayName: `${roleId} ${++n}`, roleId },
				systemActor('test'),
			);
			if (result.status !== 'applied') throw new Error('expected member');
			return {
				member: result.output,
				actor: { kind: 'member', memberId: result.output.id as MemberId, roleId },
			};
		},
		route(operationId) {
			const found = kernel.registry.routes.find((r) => r.route.operationId === operationId);
			if (!found) throw new Error(`No route ${operationId}`);
			return {
				call: (request = {}) =>
					found.route.handle(kernel.contextFor(found.extension), {
						params: undefined,
						query: undefined,
						body: undefined,
						actor: systemActor('anonymous'),
						device: null,
						files: [],
						...request,
					}),
			};
		},
		async close() {
			await kernel.stop();
			await handle.close();
		},
	};
}

export interface FakeChannel extends NotificationChannel {
	readonly sent: {
		memberId: string;
		title: string;
		body: string | null;
		url: string | null;
		source?: { kind: string; id: string };
	}[];
	attempts: number;
	/** Everybody, nobody, or the member ids that can be reached. */
	available: boolean | readonly string[];
	/** Results for the next sends, in order; afterwards `sent`. */
	next(...results: ('sent' | 'gone' | Error)[]): void;
}

/** A channel that records what it was asked to send (core tests cannot import @famos/testing). */
export function fakeChannel(id: string): FakeChannel {
	const results: ('sent' | 'gone' | Error)[] = [];
	const channel: FakeChannel = {
		id,
		label: `app:channel_${id}`,
		sent: [],
		attempts: 0,
		available: true,
		next: (...queued) => void results.push(...queued),
		isAvailableFor: async (memberId) =>
			Array.isArray(channel.available)
				? channel.available.includes(memberId)
				: channel.available === true,
		async send(memberId, message) {
			channel.attempts++;
			const result = results.shift() ?? 'sent';
			if (result instanceof Error) throw result;
			channel.sent.push({
				memberId,
				title: message.title,
				body: message.body,
				url: message.url,
				...(message.source && { source: message.source }),
			});
			return result;
		},
	};
	return channel;
}

export interface FakeExtensionChannel extends NotificationChannelDefinition {
	/** Sends that were answered `sent` or `gone`, with the context `send` received. */
	readonly sent: { memberId: string; message: NotificationMessage; ctx: JobContext }[];
	/** Every `send` call, including the ones that threw. */
	readonly attempts: number;
	/** Everybody, nobody, the member ids that can be reached, or a check of its own. */
	available:
		| boolean
		| readonly string[]
		| ((ctx: ExtensionContext, memberId: string) => Promise<boolean>);
	/** Results for the next sends, in order; afterwards `sent`. An Error is thrown. */
	next(...results: ('sent' | 'gone' | Error)[]): void;
	/** Runs inside `send` with its context, to try what the extension may touch. */
	onSend?: (ctx: JobContext, memberId: string) => Promise<void>;
}

/** A channel an extension contributes (`defineExtension({ channels })`) that records what it sent. */
export function fakeExtensionChannel(
	id: string,
	options: { label?: string; hint?: string; byDefault?: 'on' | 'off' } = {},
): FakeExtensionChannel {
	const results: ('sent' | 'gone' | Error)[] = [];
	const channel: FakeExtensionChannel = {
		id,
		label: options.label ?? `${id}:channel_label`,
		...(options.hint && { hint: options.hint }),
		...(options.byDefault && { byDefault: options.byDefault }),
		sent: [],
		attempts: 0,
		available: true,
		next: (...queued) => void results.push(...queued),
		async isAvailableFor(ctx, memberId) {
			if (typeof channel.available === 'function') return channel.available(ctx, memberId);
			return Array.isArray(channel.available)
				? channel.available.includes(memberId)
				: channel.available === true;
		},
		async send(ctx, memberId, message) {
			(channel as { attempts: number }).attempts++;
			await channel.onSend?.(ctx, memberId);
			const result = results.shift() ?? 'sent';
			if (result instanceof Error) throw result;
			channel.sent.push({ memberId, message, ctx });
			return result;
		},
	};
	return channel;
}

/**
 * `defineExtension` for an extension that lives only in a test. Its manifest is made from the
 * code (the capabilities it declares, the host contracts it provides), so a test names only
 * what it is about; a test of the
 * manifest itself uses `defineExtension` with a written one.
 */
export function defineTestExtension(
	definition: Omit<Parameters<typeof defineExtension>[0], 'manifest'> & {
		id: string;
		dependsOn?: string[];
		optional?: string[];
		calls?: string[];
		network?: ExtensionManifestInput['network'];
	},
): ExtensionDefinition {
	const { id, dependsOn, optional, calls, network, ...rest } = definition;
	return defineExtension({
		...rest,
		manifest: {
			id,
			version: '0.0.0',
			sdk: `^${SDK_VERSION}`,
			dependsOn,
			optional,
			calls,
			network,
			capabilities: (rest.capabilities ?? []).map((c) => c.id),
			provides: [
				...(rest.shareTarget ? ['shareTarget'] : []),
				...(rest.conversation ? ['conversation'] : []),
			],
		},
	});
}
