// Core cannot depend on @famos/testing (which depends on core), so its tests build the kernel
// here from the same real adapters. Extensions use createTestKernel from @famos/testing instead.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsFileStore } from '@famos/adapters/files-fs';
import {
	createSqliteQueue,
	queueMigrations,
	type SqliteJobQueue,
} from '@famos/adapters/queue-sqlite';
import { silentLogger, uuidv7Ids } from '@famos/adapters/runtime';
import { openDatabase, runMigrations } from '@famos/db';
import {
	type Actor,
	defineExtension,
	type ExtensionDefinition,
	ExternalHttpError,
	type IdentityAdmin,
	LlmError,
	type MemberId,
	type NotificationChannel,
	type RouteRequest,
	SDK_VERSION,
	systemActor,
} from '@famos/sdk';
import type { Member } from '../src/core-extension.ts';
import { createKernel, type Kernel } from '../src/kernel.ts';
import type { LanguagePort } from '../src/languages.ts';
import type { ThemePort } from '../src/themes.ts';

export interface TestClock {
	now(): number;
	advance(ms: number): void;
}

export interface TestKernel extends Kernel {
	readonly clock: TestClock;
	readonly queue: SqliteJobQueue;
	readonly passwords: Map<string, string>;
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
		translate?: (locale: string, key: string, params?: Record<string, unknown>) => string;
		languages?: LanguagePort;
		themes?: ThemePort;
		draftNotifyDelayMs?: number;
	} = {},
): Promise<TestKernel> {
	const handle = openDatabase({ path: ':memory:' });
	let now = Date.UTC(2026, 0, 1, 9);
	const clock: TestClock = { now: () => now, advance: (ms) => (now += ms) };
	const passwords = new Map<string, string>();
	const identity: IdentityAdmin = {
		setPasswordLogin: async ({ memberId, email }) => void passwords.set(memberId, email),
		setPin: async () => {},
		endSessions: async () => {},
		endDeviceSessions: async () => {},
		revokeAll: async (memberId) => void passwords.delete(memberId),
	};
	const queue = createSqliteQueue({ db: handle.db, clock, ids: uuidv7Ids });
	const kernel = createKernel({
		db: handle.db,
		queue,
		clock,
		ids: uuidv7Ids,
		logger: silentLogger,
		files: createFsFileStore(await mkdtemp(join(tmpdir(), 'famos-core-'))),
		secrets: {
			seal: (plain) => `sealed:${plain}`,
			open: (sealed) => sealed.slice('sealed:'.length),
		},
		http: {
			get: async () => {
				throw new ExternalHttpError('unreachable', 'No network in core tests');
			},
		},
		identity,
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
		infrastructureMigrations: [{ scope: 'queue', migrations: queueMigrations }],
		appVersion: '0.0.0-test',
		...(options.channels && { channels: options.channels }),
		...(options.translate && { translate: options.translate }),
		...(options.languages && { languages: options.languages }),
		...(options.themes && { themes: options.themes }),
		...(options.draftNotifyDelayMs !== undefined && {
			draftNotifyDelayMs: options.draftNotifyDelayMs,
		}),
	});
	await runMigrations(handle.db, kernel.migrationScopes, clock.now);
	await kernel.start();
	let n = 0;
	return {
		...kernel,
		clock,
		queue,
		passwords,
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
					found.route.handle(kernel.ctx, {
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
	},
): ExtensionDefinition {
	const { id, dependsOn, optional, calls, ...rest } = definition;
	return defineExtension({
		...rest,
		manifest: {
			id,
			version: '0.0.0',
			sdk: `^${SDK_VERSION}`,
			dependsOn,
			optional,
			calls,
			capabilities: (rest.capabilities ?? []).map((c) => c.id),
			provides: [
				...(rest.shareTarget ? ['shareTarget'] : []),
				...(rest.conversation ? ['conversation'] : []),
			],
		},
	});
}
