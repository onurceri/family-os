import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsFileStore } from '@famos/adapters/files-fs';
import { createSecretBox } from '@famos/adapters/llm-aisdk';
import {
	createSqliteQueue,
	queueMigrations,
	type SqliteJobQueue,
} from '@famos/adapters/queue-sqlite';
import { silentLogger, uuidv7Ids } from '@famos/adapters/runtime';
import {
	createKernel,
	type Kernel,
	type LanguagePort,
	type Member,
	type ThemePort,
} from '@famos/core';
import { openDatabase, runMigrations } from '@famos/db';
import {
	type Actor,
	type AiAreaAccess,
	type Clock,
	type ExtensionDefinition,
	type ExternalHttp,
	ExternalHttpError,
	type ExternalHttpRequest,
	type ExternalHttpResponse,
	type IdentityAdmin,
	type LlmChatRequest,
	type LlmChatResult,
	type LlmEmbedRequest,
	type LlmEmbedResult,
	LlmError,
	type LlmObjectRequest,
	type LlmObjectResult,
	type LlmPolicy,
	type LlmPort,
	type LlmTranscribeRequest,
	type LlmTranscribeResult,
	type MemberId,
	type NotificationChannel,
	type NotificationMessage,
	type RouteRequest,
	systemActor,
} from '@famos/sdk';
import { repoVocabulary } from './translate.ts';

export interface TestClock extends Clock {
	set(ms: number): void;
	advance(ms: number): void;
}

export function createTestClock(start = Date.UTC(2026, 0, 1, 9, 0, 0)): TestClock {
	let current = start;
	return {
		now: () => current,
		set: (ms) => {
			current = ms;
		},
		advance: (ms) => {
			current += ms;
		},
	};
}

export interface FakeIdentity extends IdentityAdmin {
	readonly passwords: Map<string, { email: string; password: string }>;
	readonly pins: Map<string, string>;
	/** Members and devices whose sessions were ended, in order. */
	readonly endedSessions: string[];
	readonly endedDeviceSessions: string[];
}

export function createFakeIdentity(): FakeIdentity {
	const passwords = new Map<string, { email: string; password: string }>();
	const pins = new Map<string, string>();
	const endedSessions: string[] = [];
	const endedDeviceSessions: string[] = [];
	return {
		passwords,
		pins,
		endedSessions,
		endedDeviceSessions,
		async endSessions(memberId) {
			endedSessions.push(memberId);
		},
		async endDeviceSessions(deviceId) {
			endedDeviceSessions.push(deviceId);
		},
		async setPasswordLogin({ memberId, email, password }) {
			passwords.set(memberId, { email, password });
		},
		async setPin({ memberId, pin }) {
			pins.set(memberId, pin);
		},
		async revokeAll(memberId) {
			passwords.delete(memberId);
			pins.delete(memberId);
		},
	};
}

/** A scripted response: the output, an error to throw, or a function of the request. */
export type FakeLlmResponse = unknown | Error | ((request: LlmObjectRequest<unknown>) => unknown);

/** One step of a scripted chat turn: call a tool by name with an input, or answer in text. */
export type FakeChatStep = { tool: string; input?: unknown } | { text: string };
/** A scripted chat turn: steps in order, an error to throw, or a function of the request. */
export type FakeChatTurn =
	| readonly FakeChatStep[]
	| Error
	| ((request: LlmChatRequest) => readonly FakeChatStep[]);

/** Vector size of the fake embedding model. */
export const FAKE_EMBED_DIMENSIONS = 128;

/**
 * The fake embedding model: a hashed bag of words. Texts that share words get similar vectors,
 * so tests can assert a ranking without a real model; the same text always gives the same vector.
 */
export function fakeEmbedding(text: string): Float32Array {
	const vector = new Float32Array(FAKE_EMBED_DIMENSIONS);
	for (const word of text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
		let hash = 2166136261;
		for (const ch of word) hash = Math.imul(hash ^ (ch.codePointAt(0) ?? 0), 16777619);
		const slot = (hash >>> 0) % FAKE_EMBED_DIMENSIONS;
		vector[slot] = (vector[slot] ?? 0) + 1;
	}
	return vector;
}

export interface FakeLlm extends LlmPort {
	/** Every embedding request, in order. */
	readonly embedCalls: LlmEmbedRequest[];
	/**
	 * The key of the embedding model; null (the default) means none is set, and embedding fails as
	 * "not configured". Changing it simulates choosing another model.
	 */
	embedModel: string | null;
	/** Makes the next embedding calls fail with this error (null: work again). */
	embedError: Error | null;
	/** Every chat request, in order. */
	readonly chatCalls: LlmChatRequest[];
	/**
	 * What each tool call of the scripted chats returned to the model, in order (or the error it
	 * ended in), to assert on what the model saw.
	 */
	readonly chatTrace: { tool: string; input: unknown; result: string; ok: boolean }[];
	/**
	 * Queues scripted chat turns, one per `chat()` call. Tool steps run the request's tools like
	 * the real loop (a tool the request lacks fails), text steps stream through `onText`; at most
	 * `maxSteps` tool rounds run, and when the limit is hit the answer stays empty.
	 */
	respondChat(...turns: FakeChatTurn[]): void;
	/** Every request, in order. */
	readonly calls: LlmObjectRequest<unknown>[];
	/** Queues responses, used in order. With none queued, calls fail as "not configured". */
	respond(...responses: FakeLlmResponse[]): void;
	/** Every transcription request, in order. */
	readonly transcribeCalls: LlmTranscribeRequest[];
	/** Queues transcripts (or errors to throw), used in order. With none queued: "not configured". */
	respondTranscript(
		...responses: (string | Error | ((request: LlmTranscribeRequest) => string))[]
	): void;
	/** What `policy()` returns; change it to test privacy settings and switches. */
	readonly privacy: LlmPolicy;
	/**
	 * How far the AI may use an area. `createTestKernel` reads core's setting; like the real
	 * adapter, calls naming an `off` area fail with `disabled`, and a `local` area with
	 * `local_required` unless `privacy.local` is true.
	 */
	areaAccess: (extensionId: string) => AiAreaAccess;
}

/** A model stand-in for tests: outputs are validated against the request schema, like the real adapter. */
export function createFakeLlm(): FakeLlm {
	const calls: LlmObjectRequest<unknown>[] = [];
	const queue: FakeLlmResponse[] = [];
	const transcribeCalls: LlmTranscribeRequest[] = [];
	const transcripts: (string | Error | ((request: LlmTranscribeRequest) => string))[] = [];
	const privacy: LlmPolicy = {
		enabled: true,
		sendFiles: true,
		sendPeople: true,
		sendVoice: true,
		local: false,
		model: null,
	};
	const chatCalls: LlmChatRequest[] = [];
	const chatTrace: FakeLlm['chatTrace'] = [];
	const chatQueue: FakeChatTurn[] = [];
	const enforce = (areas: readonly string[]) => {
		for (const area of areas) {
			const access = fake.areaAccess(area);
			if (access === 'off') throw new LlmError('disabled', `AI access to ${area} is off`);
			if (access === 'local' && !privacy.local)
				throw new LlmError('local_required', `${area} may only use a local model`);
		}
	};
	const embedCalls: LlmEmbedRequest[] = [];
	const fake: FakeLlm = {
		embedCalls,
		embedModel: null,
		embedError: null,
		async embed(request): Promise<LlmEmbedResult> {
			embedCalls.push(request);
			if (!privacy.enabled) throw new LlmError('disabled', 'AI is turned off');
			if (fake.embedModel === null) throw new LlmError('not_configured', 'No embedding model');
			enforce([request.area]);
			if (fake.embedError) throw fake.embedError;
			return {
				vectors: request.texts.map(fakeEmbedding),
				model: fake.embedModel,
				dimensions: FAKE_EMBED_DIMENSIONS,
			};
		},
		chatCalls,
		chatTrace,
		respondChat: (...turns) => void chatQueue.push(...turns),
		async chat(request): Promise<LlmChatResult> {
			chatCalls.push(request);
			if (!privacy.enabled) throw new LlmError('disabled', 'AI is turned off');
			enforce(request.areas);
			if (chatQueue.length === 0) throw new LlmError('not_configured', 'No fake chat queued');
			const next = chatQueue.shift() as FakeChatTurn;
			if (next instanceof Error) throw next;
			const steps = typeof next === 'function' ? next(request) : next;
			let text = '';
			const toolCalls: { name: string; ok: boolean }[] = [];
			let rounds = 0;
			for (const step of steps) {
				// The answer is a step of its own: after `maxSteps` tool rounds there is none left.
				if (rounds >= request.maxSteps) break;
				if ('text' in step) {
					const delta = (text ? '\n\n' : '') + step.text;
					for (const piece of delta.match(/\S+\s*|\s+/g) ?? []) request.onText?.(piece);
					text += delta;
					break;
				}
				// The real loop offers no tools once the host closes them.
				if (request.toolsClosed?.()) continue;
				rounds++;
				const tool = request.tools.find((t) => t.name === step.tool);
				request.onToolCall?.(step.tool, step.input);
				let ok = true;
				let result: string;
				try {
					if (!tool) throw new Error(`Unknown tool ${step.tool}`);
					const value = await tool.execute(step.input ?? {});
					result = typeof value === 'string' ? value : JSON.stringify(value ?? null);
				} catch (error) {
					ok = false;
					result = `Error: ${error instanceof Error ? error.message : 'the tool failed'}`;
				}
				chatTrace.push({ tool: step.tool, input: step.input, result, ok });
				toolCalls.push({ name: step.tool, ok });
				request.onToolResult?.(step.tool, ok);
			}
			return {
				text: text.trim(),
				toolCalls,
				model: 'fake / model',
				usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
			};
		},
		calls,
		transcribeCalls,
		respondTranscript: (...responses) => void transcripts.push(...responses),
		async transcribe(request): Promise<LlmTranscribeResult> {
			transcribeCalls.push(request);
			enforce(request.areas);
			if (!privacy.sendVoice) throw new LlmError('disabled', 'Voice notes are not sent');
			if (transcripts.length === 0)
				throw new LlmError('not_configured', 'No fake transcript queued');
			const next = transcripts.shift();
			if (next instanceof Error) throw next;
			const text = typeof next === 'function' ? next(request) : (next as string);
			return {
				text,
				model: 'fake / transcriber',
				usage: { inputTokens: null, outputTokens: null, cost: 0 },
			};
		},
		privacy,
		areaAccess: () => 'any',
		policy: async (_feature, role) => ({
			...privacy,
			model: role === 'embed' ? fake.embedModel : privacy.model,
		}),
		respond: (...responses) => void queue.push(...responses),
		async generateObject<T>(request: LlmObjectRequest<T>): Promise<LlmObjectResult<T>> {
			calls.push(request as LlmObjectRequest<unknown>);
			enforce(request.areas);
			if (queue.length === 0) throw new LlmError('not_configured', 'No fake response queued');
			const next = queue.shift();
			if (next instanceof Error) throw next;
			const raw = typeof next === 'function' ? next(request as LlmObjectRequest<unknown>) : next;
			const parsed = request.schema.safeParse(raw);
			if (!parsed.success)
				throw new LlmError('invalid_output', 'Fake output does not match the schema');
			return {
				output: parsed.data,
				model: 'fake / model',
				usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
			};
		},
	};
	return fake;
}

export interface FakeChannel extends NotificationChannel {
	/** Messages that were sent (and answered `sent` or `gone`), in order. */
	readonly sent: { memberId: string; message: NotificationMessage }[];
	/** Every `send` call, including the ones that threw. */
	readonly attempts: number;
	/** `true` (everybody), `false` (nobody) or the member ids that can be reached. */
	available: boolean | readonly string[];
	/** Queues results for the next sends, used in order; afterwards `sent`. An Error is thrown. */
	next(...results: ('sent' | 'gone' | Error)[]): void;
}

/** A notification channel stand-in that records what it was asked to send. */
export function createFakeChannel(id: string, label = `app:channel_${id}`): FakeChannel {
	const results: ('sent' | 'gone' | Error)[] = [];
	const channel: FakeChannel = {
		id,
		label,
		sent: [],
		attempts: 0,
		available: true,
		next: (...queued) => void results.push(...queued),
		async isAvailableFor(memberId) {
			return Array.isArray(channel.available)
				? channel.available.includes(memberId)
				: channel.available === true;
		},
		async send(memberId, message) {
			(channel as { attempts: number }).attempts++;
			const result = results.shift() ?? 'sent';
			if (result instanceof Error) throw result;
			channel.sent.push({ memberId, message });
			return result;
		},
	};
	return channel;
}

export interface FakeHttp extends ExternalHttp {
	/** Every request, in order. */
	readonly requests: ExternalHttpRequest[];
	/**
	 * What a URL answers (`webcal:` and `https:` forms are the same). A function may answer per
	 * request (for example by looking at `conditional`); an Error is thrown (use `ExternalHttpError`).
	 */
	serve(
		url: string,
		response:
			| {
					text?: string;
					contentType?: string;
					etag?: string;
					lastModified?: string;
			  }
			| ExternalHttpError
			| ((request: ExternalHttpRequest) => ExternalHttpResponse | ExternalHttpError),
	): void;
	/** Forgets what a URL answers: it becomes unreachable. */
	remove(url: string): void;
}

const keyOf = (url: string) => url.trim().replace(/^webcals?:/i, 'https:');

/** Outbound HTTP stand-in for tests: no network; unknown URLs are unreachable. */
export function createFakeHttp(): FakeHttp {
	const requests: ExternalHttpRequest[] = [];
	const routes = new Map<string, Parameters<FakeHttp['serve']>[1]>();
	return {
		requests,
		serve: (url, response) => void routes.set(keyOf(url), response),
		remove: (url) => void routes.delete(keyOf(url)),
		async get(request) {
			requests.push(request);
			const route = routes.get(keyOf(request.url));
			if (!route) throw new ExternalHttpError('unreachable', 'No fake response');
			const answer = typeof route === 'function' ? route(request) : route;
			if (answer instanceof Error) throw answer;
			if ('status' in answer) return answer;
			return {
				status: 200,
				text: answer.text ?? '',
				contentType: answer.contentType ?? null,
				etag: answer.etag ?? null,
				lastModified: answer.lastModified ?? null,
			};
		},
	};
}

export interface TestKernel extends Kernel {
	readonly clock: TestClock;
	readonly identity: FakeIdentity;
	readonly llm: FakeLlm;
	readonly http: FakeHttp;
	readonly queue: SqliteJobQueue;
	/** Creates a member and returns an Actor for it. */
	member(
		/** A built-in role (`admin`, `member`, `supervised`, `guest`) or a custom role id. */
		roleId?: string,
		displayName?: string,
	): Promise<{ actor: Actor & { kind: 'member' }; member: Member }>;
	/** Calls a route handler directly; omitted request fields get neutral defaults. */
	route(operationId: string): {
		// biome-ignore lint/suspicious/noExplicitAny: test helper over heterogeneous route responses.
		call(request?: Partial<RouteRequest<any, any, any>>): Promise<any>;
	};
	close(): Promise<void>;
}

/**
 * A real kernel on in-memory SQLite with real migrations, a SQLite queue, a temp-dir file store
 * a fake identity adapter and a fake model (`llm.respond(...)`). Use `worker.drain()` to run queued jobs deterministically.
 */
export async function createTestKernel(
	options: {
		extensions?: ExtensionDefinition[];
		clock?: TestClock;
		/** A real model for evaluations; tests use the fake (`k.llm`). */
		llm?: LlmPort;
		/** Notification channels (see `createFakeChannel`). */
		channels?: readonly NotificationChannel[];
		/** Renders translation keys; by default a notification's text is its key. */
		translate?: (locale: string, key: string, params?: Record<string, unknown>) => string;
		/** The words a key lists in every language; by default those of the repository's packs. */
		vocabulary?: (key: string) => readonly string[];
		/** The language packs; by default English is listed and any well-formed code may be chosen. */
		languages?: LanguagePort;
		/** The theme packs; by default only the default theme is listed. */
		themes?: ThemePort;
	} = {},
): Promise<TestKernel> {
	const handle = openDatabase({ path: ':memory:' });
	const clock = options.clock ?? createTestClock();
	const identity = createFakeIdentity();
	const llm = createFakeLlm();
	const http = createFakeHttp();
	const filesDir = await mkdtemp(join(tmpdir(), 'famos-files-'));
	const queue = createSqliteQueue({ db: handle.db, clock, ids: uuidv7Ids });
	const kernel = createKernel({
		db: handle.db,
		queue,
		clock,
		ids: uuidv7Ids,
		logger: silentLogger,
		files: createFsFileStore(filesDir),
		secrets: createSecretBox('test-secret', 'extension-secrets'),
		http,
		identity,
		llm: options.llm ?? llm,
		extensions: options.extensions ?? [],
		infrastructureMigrations: [{ scope: 'queue', migrations: queueMigrations }],
		appVersion: '0.0.0-test',
		...(options.channels && { channels: options.channels }),
		...(options.translate && { translate: options.translate }),
		vocabulary: options.vocabulary ?? repoVocabulary(),
		...(options.languages && { languages: options.languages }),
		...(options.themes && { themes: options.themes }),
	});
	await runMigrations(handle.db, kernel.migrationScopes, clock.now);
	await kernel.start();
	llm.areaAccess = (id) => kernel.aiAreas.access(id);

	let counter = 0;
	return {
		...kernel,
		clock,
		identity,
		llm,
		http,
		queue,
		async member(roleId = 'admin', displayName) {
			counter++;
			const result = await kernel.runner.invoke<Member>(
				'core.createMember',
				{ displayName: displayName ?? `${roleId} ${counter}`, roleId },
				systemActor('test'),
			);
			if (result.status !== 'applied') throw new Error('expected member to be created');
			const member = result.output;
			return { member, actor: { kind: 'member', memberId: member.id as MemberId, roleId } };
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
						// Tests call routes as the backend; pass `actor` to test what a member sees.
						actor: systemActor('test'),
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

/** For tests that migrate a database themselves. */
export { openDatabase, runMigrations } from '@famos/db';
export { type EnvLlm, llmFromEnv } from './llm-from-env.ts';

export { repoTranslate, repoVocabulary } from './translate.ts';
