import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDatabase, runMigrations } from '@famos/db';
import { type AiAreaAccess, LlmError, type LlmPort } from '@famos/sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	type AiSettingsService,
	aiMigrations,
	aiTables,
	createAiSdkLlm,
	createAiSettings,
	createSecretBox,
	monthBounds,
} from '../src/llm-aisdk/index.ts';
import { extractJson, outputModeFor } from '../src/llm-aisdk/output.ts';
import { silentLogger, uuidv7Ids } from '../src/runtime/index.ts';

// A stand-in OpenAI-compatible server: behaviour is chosen by the requested model id.
type Seen = { url: string; auth: string | undefined; body: Record<string, unknown> };
const seen: Seen[] = [];
/**
 * Calls that must succeed get a long limit: the limit is only a backstop, so a busy machine
 * cannot turn a slow-but-correct response into a failure.
 */
const CALL_TIMEOUT_MS = 30_000;

const server = http.createServer((req, res) => {
	let raw = '';
	req.on('data', (chunk) => (raw += chunk));
	req.on('end', () => {
		const auth = req.headers.authorization;
		res.setHeader('content-type', 'application/json');
		if (req.url?.endsWith('/key')) {
			return res.writeHead(auth === 'Bearer good-key' ? 200 : 401).end('{}');
		}
		if (req.url?.endsWith('/models')) {
			// Under /public/ the list needs no key, like OpenRouter's.
			if (auth !== 'Bearer good-key' && !req.url.includes('/public/'))
				return res.writeHead(401).end('{}');
			return res.end(
				JSON.stringify({ data: [{ id: 'vendor/b-model' }, { id: 'vendor/a-model' }] }),
			);
		}
		if (req.url?.endsWith('/audio/transcriptions')) {
			// Multipart: pick the text fields and the file part's headers out of the raw body.
			const field = (name: string) =>
				new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(raw)?.[1];
			const file = /name="file"; filename="([^"]*)"\r\nContent-Type: ([^\r]*)\r\n/i.exec(raw);
			const fields = {
				model: field('model'),
				language: field('language'),
				response_format: field('response_format'),
				filename: file?.[1],
				contentType: file?.[2],
			};
			seen.push({ url: req.url, auth, body: fields });
			const model = fields.model;
			if (model === 'slow-stt') return; // never answers: the client's own timeout ends the call
			if (model === 'denied-stt') return res.writeHead(401).end('{}');
			if (model === 'big-stt') return res.writeHead(413).end('{"error":"too big"}');
			if (model === 'missing-stt') return res.writeHead(404).end('{}');
			if (model === 'down-stt') return res.writeHead(503).end('{}');
			return res.end(
				JSON.stringify({
					text: ' Ayşe will pick up Elif at four. ',
					...(model === 'priced-stt' && { usage: { cost: 0.0006 } }),
				}),
			);
		}
		const body = JSON.parse(raw) as Record<string, unknown>;
		seen.push({ url: req.url ?? '', auth, body });
		const model = body.model as string;
		if (req.url?.endsWith('/embeddings')) {
			if (model === 'embed-denied') return res.writeHead(401).end('{}');
			if (model === 'embed-down') return res.writeHead(503).end('{}');
			const input = body.input as string[];
			const data = (model === 'embed-short' ? input.slice(1) : input).map((text, index) => ({
				object: 'embedding',
				index,
				embedding: [text.length, 1, 0, 0],
			}));
			return res.end(
				JSON.stringify({
					object: 'list',
					data,
					model,
					usage: { prompt_tokens: 7, total_tokens: 7 },
				}),
			);
		}
		if (body.stream) return streamChat(model, body, res);
		if (model === 'slow') return; // never answers: the client's own timeout ends the call
		if (model === 'no-zdr')
			return res.writeHead(404).end(
				JSON.stringify({
					error: { message: 'No endpoints found matching your data policy (Zero data retention)' },
				}),
			);
		if (model === 'denied')
			return res.writeHead(401).end(JSON.stringify({ error: { message: 'bad key' } }));
		// A model without a thinking mode refuses the setting.
		if (model === 'no-thinking' && (body.reasoning_effort || body.reasoning))
			return res
				.writeHead(400)
				.end(JSON.stringify({ error: { message: 'Unsupported parameter: reasoning_effort' } }));
		const format = (body.response_format as { type?: string } | undefined)?.type;
		// A server that takes no response format at all.
		if (model === 'plain-server' && format)
			return res
				.writeHead(400)
				.end(JSON.stringify({ error: { message: 'response_format is not supported' } }));
		// A model whose provider cannot compile the JSON Schema.
		if (model === 'openai/gpt-4.1-strict' && format === 'json_schema')
			return res
				.writeHead(400)
				.end(JSON.stringify({ error: { message: 'Invalid schema for response_format' } }));
		// Under a JSON Schema this model repeats one tag until the output cap ends it, as Gemini
		// does with the Inbox schema; asked for plain JSON it answers well.
		const loops = model === 'openai/gpt-4.1-loops' && format === 'json_schema';
		const content = loops
			? `{"title":"Zoo trip","tags":["school"${',"Zoo trip with the school"'.repeat(40)}`
			: model === 'plain-server'
				? 'Here it is:\n```json\n{"title": "Zoo trip", "date": "2026-10-17"}\n```'
				: model === 'talkative'
					? '<think>The {date} is Friday.</think>Sure! {"title": "Zoo trip {school}", "date": "2026-10-17"} Anything else?'
					: model === 'rambling' || model === 'priced-rambling'
						? 'not json at all'
						: model === 'cut-off'
							? '{"title": "Zoo tr'
							: JSON.stringify({ title: 'Zoo trip', date: '2026-10-17' });
		res.end(
			JSON.stringify({
				id: 'c1',
				object: 'chat.completion',
				created: 1,
				model,
				choices: [
					{
						index: 0,
						finish_reason: model === 'cut-off' || loops ? 'length' : 'stop',
						message: { role: 'assistant', content },
					},
				],
				usage: {
					prompt_tokens: 120,
					completion_tokens: 30,
					total_tokens: 150,
					...(model === 'cut-off' && { completion_tokens_details: { reasoning_tokens: 25 } }),
					...((model === 'priced' || model === 'priced-rambling') && { cost: 0.00042 }),
				},
			}),
		);
	});
});

/**
 * Streamed chat completions with tool calls. `chat-tools` calls the tool `ping` first and answers
 * with its result; `chat-loop` never stops calling it; `chat-priced` reports a cost; `chat-down`
 * fails.
 */
function streamChat(model: string, body: Record<string, unknown>, res: http.ServerResponse) {
	if (model === 'chat-down') return void res.writeHead(503).end('{}');
	const messages = body.messages as { role: string; content?: unknown }[];
	const lastTool = messages.findLast((m) => m.role === 'tool');
	const send = (delta: Record<string, unknown>, finish: string | null) =>
		res.write(
			`data: ${JSON.stringify({
				id: 'c1',
				object: 'chat.completion.chunk',
				created: 1,
				model,
				choices: [{ index: 0, delta, finish_reason: finish }],
			})}\n\n`,
		);
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	if (
		model === 'chat-loop' ||
		(['chat-tools', 'chat-priced', 'chat-unknown'].includes(model) && !lastTool)
	) {
		send(
			{
				role: 'assistant',
				tool_calls: [
					{
						index: 0,
						id: `call_${messages.length}`,
						type: 'function',
						function: {
							name: model === 'chat-unknown' ? 'nope' : 'ping',
							arguments: '{"x":1}',
						},
					},
				],
			},
			null,
		);
		send({}, 'tool_calls');
	} else {
		send({ role: 'assistant', content: 'Pong: ' }, null);
		send({ content: String(lastTool?.content ?? '') }, null);
		send({}, 'stop');
	}
	res.write(
		`data: ${JSON.stringify({
			id: 'c1',
			object: 'chat.completion.chunk',
			created: 1,
			model,
			choices: [],
			usage: {
				prompt_tokens: 100,
				completion_tokens: 10,
				total_tokens: 110,
				...(model === 'chat-priced' && { cost: 0.001 }),
			},
		})}\n\n`,
	);
	res.end('data: [DONE]\n\n');
}

let baseUrl = '';
beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(
	() =>
		new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		}),
);

const NOW = Date.UTC(2026, 9, 6, 9);
let clockNow = NOW;
const clock = { now: () => clockNow };
const timeZone = async () => 'Europe/Istanbul';
let db: ReturnType<typeof openDatabase>['db'];
let settings: AiSettingsService;
let llm: LlmPort;
/** AI access per area for the stand-in core setting; areas not listed are open. */
let areas: Record<string, AiAreaAccess> = {};
/** What the injected resolver answers for host names (no real DNS in tests). */
let dns: Record<string, string[]> = {};

beforeEach(async () => {
	seen.length = 0;
	clockNow = NOW;
	areas = {};
	dns = {};
	({ db } = openDatabase({ path: ':memory:' }));
	await runMigrations(db, [{ scope: 'ai', migrations: aiMigrations }]);
	const box = createSecretBox('s'.repeat(32));
	settings = createAiSettings({
		db,
		box,
		clock,
		ids: uuidv7Ids,
		timeZone,
		resolve: async (host) => dns[host] ?? [],
	});
	llm = createAiSdkLlm({
		db,
		settings,
		clock,
		ids: uuidv7Ids,
		logger: silentLogger,
		timeZone,
		areaAccess: (id) => areas[id] ?? 'any',
	});
});

const Trip = z.object({ title: z.string(), date: z.string() });
const systemOf = (call: Seen | undefined) =>
	String(
		((call?.body.messages ?? []) as { role: string; content: unknown }[]).find(
			(m) => m.role === 'system',
		)?.content ?? '',
	);
const ask = (role: 'fast' | 'vision' | 'smart' = 'smart', timeoutMs = CALL_TIMEOUT_MS) =>
	llm.generateObject({
		role,
		feature: 'test.extract',
		areas: ['test'],
		schema: Trip,
		prompt: 'School trip Friday',
		timeoutMs,
		jobId: 'job_1',
	});

async function useModel(model: string, kind: 'openrouter' | 'openai-compatible' = 'openrouter') {
	const provider = await settings.createProvider({
		name: 'Router',
		kind,
		baseUrl,
		apiKey: 'good-key',
	});
	await settings.setRoles({
		fast: null,
		vision: null,
		smart: { providerId: provider.id, model },
		transcribe: null,
		embed: null,
	});
	return provider;
}

async function useTranscriber(
	model: string,
	kind: 'openrouter' | 'openai-compatible' | 'ollama' = 'openai-compatible',
) {
	const provider = await settings.createProvider({
		name: 'Speech',
		kind,
		baseUrl,
		apiKey: 'good-key',
	});
	await settings.setRoles({
		...(await settings.roles()),
		transcribe: { providerId: provider.id, model },
		embed: null,
	});
	return provider;
}
const audio = new Uint8Array([79, 103, 103, 83, 0, 1, 2]);
const say = (timeoutMs = CALL_TIMEOUT_MS) =>
	llm.transcribe({
		feature: 'test.transcribe',
		areas: ['test'],
		audio,
		mediaType: 'audio/ogg',
		filename: 'voice.ogg',
		language: 'tr',
		timeoutMs,
		memberId: 'mem_1',
		jobId: 'job_1',
	});

describe('AI settings', () => {
	it('seals API keys and never returns them', async () => {
		const provider = await settings.createProvider({
			name: 'OpenRouter',
			kind: 'openrouter',
			apiKey: 'sk-secret-123',
		});
		expect(provider).toMatchObject({
			baseUrl: 'https://openrouter.ai/api/v1',
			hasKey: true,
			keyReadable: true,
		});
		expect(JSON.stringify(provider)).not.toContain('sk-secret');
		const stored = await db
			.selectFrom('ai_providers' as never)
			.selectAll()
			.executeTakeFirstOrThrow();
		expect(JSON.stringify(stored)).not.toContain('sk-secret');
		expect((await settings.resolve(provider.id)).apiKey).toBe('sk-secret-123');
		// With another FAMOS_SECRET the key cannot be read and must be entered again.
		const other = createAiSettings({
			db,
			box: createSecretBox('t'.repeat(32)),
			clock,
			ids: uuidv7Ids,
			timeZone,
		});
		expect((await other.get()).providers[0]).toMatchObject({ hasKey: true, keyReadable: false });
	});

	it('validates roles and unsets them when their provider is removed', async () => {
		const provider = await useModel('priced');
		await expect(
			settings.setRoles({
				fast: { providerId: 'ai_provider_nope', model: 'x' },
				vision: null,
				smart: null,
				transcribe: null,
				embed: null,
			}),
		).rejects.toMatchObject({ code: 'bad_request' });
		await settings.deleteProvider(provider.id);
		expect((await settings.get()).roles).toEqual({
			fast: null,
			vision: null,
			smart: null,
			transcribe: null,
			embed: null,
		});
	});

	it('tests a connection by listing models', async () => {
		const provider = await useModel('priced');
		expect(await settings.listModels(provider.id)).toEqual({
			ok: true,
			models: ['vendor/a-model', 'vendor/b-model'],
		});
		await settings.updateProvider(provider.id, { apiKey: 'wrong' });
		expect(await settings.listModels(provider.id)).toMatchObject({ ok: false, reason: 'auth' });
		// OpenRouter's model list needs no key: the key is checked separately.
		const router = await settings.createProvider({
			name: 'R',
			kind: 'openrouter',
			baseUrl: `${baseUrl}/public`,
			apiKey: 'wrong',
		});
		expect(await settings.listModels(router.id)).toMatchObject({ ok: false, reason: 'auth' });
		await settings.updateProvider(router.id, { apiKey: 'good-key' });
		expect(await settings.listModels(router.id)).toMatchObject({ ok: true });
		await settings.updateProvider(provider.id, { baseUrl: 'http://127.0.0.1:9/v1' });
		expect(await settings.listModels(provider.id)).toMatchObject({
			ok: false,
			reason: 'unreachable',
		});
	});

	it('drops a stored key when the provider address changes', async () => {
		const provider = await settings.createProvider({
			name: 'P',
			kind: 'openai-compatible',
			baseUrl: 'http://ai.lan/v1',
			apiKey: 'secret',
		});
		expect((await settings.updateProvider(provider.id, { name: 'Renamed' })).hasKey).toBe(true);
		expect(
			(await settings.updateProvider(provider.id, { baseUrl: 'http://ai.lan/v1' })).hasKey,
		).toBe(true);
		const moved = await settings.updateProvider(provider.id, {
			baseUrl: 'https://evil.example/v1',
		});
		expect(moved.hasKey).toBe(false);
		const rekeyed = await settings.updateProvider(provider.id, {
			baseUrl: 'http://ai2.lan/v1',
			apiKey: 'new',
		});
		expect(rekeyed.hasKey).toBe(true);
	});

	it('keeps the provider from the environment in line with it on every start', async () => {
		expect(
			await settings.syncFromEnvironment({
				name: 'Ollama',
				kind: 'ollama',
				models: { fast: 'llama3.2', smart: 'qwen3' },
			}),
		).toBe('created');
		let s = await settings.get();
		expect(s.providers).toHaveLength(1);
		expect(s.providers[0]).toMatchObject({ managed: true, name: 'Ollama' });
		expect(s.roles).toMatchObject({
			fast: { model: 'llama3.2' },
			vision: null,
			smart: { model: 'qwen3' },
		});

		// The family points "smart" at its own provider; the next start leaves that alone.
		const own = await settings.createProvider({ name: 'Mine', kind: 'openrouter', apiKey: 'k' });
		await settings.setRoles({ ...s.roles, smart: { providerId: own.id, model: 'big' } });
		expect(
			await settings.syncFromEnvironment({
				name: 'Ollama',
				kind: 'ollama',
				models: { fast: 'llama3.3', smart: 'qwen3' },
			}),
		).toBe('updated');
		s = await settings.get();
		expect(s.roles).toMatchObject({ fast: { model: 'llama3.3' }, smart: { model: 'big' } });

		// It cannot be edited or removed in the app.
		const env = s.providers.find((p) => p.managed);
		await expect(settings.updateProvider(env?.id ?? '', { name: 'x' })).rejects.toMatchObject({
			code: 'bad_request',
		});
		await expect(settings.deleteProvider(env?.id ?? '')).rejects.toBeTruthy();

		// The variables are gone: so is the provider, and the roles that used it.
		expect(await settings.syncFromEnvironment(null)).toBe('removed');
		s = await settings.get();
		expect(s.providers.map((p) => p.name)).toEqual(['Mine']);
		expect(s.roles).toMatchObject({ fast: null, smart: { model: 'big' } });
		expect(await settings.syncFromEnvironment(null)).toBe('unchanged');
	});

	it('computes months in the family time zone', () => {
		// 31 Oct 22:30 UTC is already 1 November in Istanbul (UTC+3).
		expect(monthBounds('Europe/Istanbul', Date.UTC(2026, 9, 31, 22, 30)).month).toBe('2026-11');
	});
});

describe('AI SDK LlmPort', () => {
	it('returns validated structured output and records usage with the reported cost', async () => {
		await useModel('priced');
		const result = await ask();
		expect(result).toEqual({
			output: { title: 'Zoo trip', date: '2026-10-17' },
			model: 'Router / priced',
			usage: { inputTokens: 120, outputTokens: 30, reasoningTokens: null, cost: 0.00042 },
			outputMode: 'json',
		});
		// OpenRouter is asked to report cost; a model not known to follow a JSON Schema is asked
		// for a JSON object, and reads the schema in the system prompt.
		expect(seen[0]).toMatchObject({
			auth: 'Bearer good-key',
			body: {
				usage: { include: true },
				// Zero data retention by default.
				provider: { zdr: true, data_collection: 'deny' },
				response_format: { type: 'json_object' },
			},
		});
		expect(systemOf(seen[0])).toContain('"title"');
		const usage = await settings.usage();
		expect(usage).toMatchObject({
			month: '2026-10',
			total: { calls: 1, errors: 0, inputTokens: 120, outputTokens: 30, cost: 0.00042 },
			byFeature: [{ key: 'test.extract', calls: 1 }],
		});
	});

	it('follows the privacy settings', async () => {
		expect(await settings.privacy()).toEqual({
			sendFiles: true,
			sendPeople: true,
			sendVoice: true,
			zeroRetention: true,
		});
		expect(await llm.policy('test.extract', 'smart')).toEqual({
			enabled: true,
			sendFiles: true,
			sendPeople: true,
			sendVoice: true,
			local: false,
			model: null,
		});
		await useModel('priced');
		await settings.setPrivacy({
			sendFiles: false,
			sendPeople: false,
			sendVoice: false,
			zeroRetention: false,
		});
		expect(await llm.policy('test.extract', 'smart')).toMatchObject({
			sendFiles: false,
			sendPeople: false,
			sendVoice: false,
		});
		await llm.generateObject({
			role: 'smart',
			feature: 'test.extract',
			areas: ['test'],
			schema: Trip,
			prompt: 'Read this',
			files: [{ data: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png' }],
			timeoutMs: CALL_TIMEOUT_MS,
		});
		expect(seen[0]?.body.provider).toBeUndefined();
		const messages = (seen[0]?.body.messages ?? []) as { content: unknown }[];
		expect(JSON.stringify(messages)).not.toContain('image');
	});

	it('refuses calls when AI or the feature is turned off', async () => {
		await useModel('priced');
		await settings.setSwitches({ enabled: true, off: ['test.extract'] });
		expect((await llm.policy('test.extract', 'smart')).enabled).toBe(false);
		expect((await llm.policy('other.feature', 'smart')).enabled).toBe(true);
		await expect(ask()).rejects.toMatchObject({ code: 'disabled', retryable: false });
		await settings.setSwitches({ enabled: false, off: [] });
		expect((await llm.policy('other.feature', 'smart')).enabled).toBe(false);
		await settings.setSwitches({ enabled: true, off: [] });
		await expect(ask()).resolves.toMatchObject({ model: 'Router / priced' });
		// Refused calls never reach the provider.
		expect(seen).toHaveLength(1);
	});

	it('explains when no provider meets the data policy', async () => {
		await useModel('no-zdr');
		await expect(ask()).rejects.toMatchObject({ code: 'data_policy', retryable: false });
	});

	it('sends files as image parts', async () => {
		await useModel('priced', 'openai-compatible');
		await llm.generateObject({
			role: 'smart',
			feature: 'test.extract',
			areas: ['test'],
			schema: Trip,
			prompt: 'Read this',
			files: [{ data: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png' }],
			timeoutMs: CALL_TIMEOUT_MS,
		});
		const messages = (seen[0]?.body.messages ?? []) as { role: string; content: unknown[] }[];
		const content = messages.find((m) => m.role === 'user')?.content;
		expect(content?.[1]).toMatchObject({
			type: 'image_url',
			image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) },
		});
		expect(seen[0]?.body.usage).toBeUndefined();
	});

	it('fails clearly, records failures, and says whether to retry', async () => {
		await expect(ask('fast')).rejects.toMatchObject({ code: 'not_configured', retryable: false });
		await useModel('denied');
		await expect(ask()).rejects.toMatchObject({ code: 'auth', retryable: false });
		await useModel('slow');
		await expect(ask('smart', 200)).rejects.toMatchObject({ code: 'timeout', retryable: true });
		await useModel('rambling');
		await expect(ask()).rejects.toMatchObject({ code: 'invalid_output', retryable: true });
		expect((await settings.usage()).total).toMatchObject({ calls: 3, errors: 3 });
	});

	it('passes the output cap on, and fails an answer the cap cut off without a retry', async () => {
		await useModel('priced', 'openai-compatible');
		await llm.generateObject({
			role: 'smart',
			feature: 'test.extract',
			areas: ['test'],
			schema: Trip,
			prompt: 'School trip Friday',
			timeoutMs: 1_000,
			maxOutputTokens: 321,
			temperature: 0,
		});
		expect(seen.at(-1)?.body.max_tokens).toBe(321);
		expect(seen.at(-1)?.body.temperature).toBe(0);
		await ask();
		expect(seen.at(-1)?.body.max_tokens).toBeUndefined();
		expect(seen.at(-1)?.body.temperature).toBeUndefined();

		await useModel('cut-off');
		const error = await llm
			.generateObject({
				role: 'smart',
				feature: 'test.extract',
				areas: ['test'],
				schema: Trip,
				prompt: 'School trip Friday',
				timeoutMs: 1_000,
				maxOutputTokens: 5,
			})
			.catch((e: unknown) => e);
		expect(error).toMatchObject({ code: 'output_too_long', retryable: false });
		// The failed call still says what it used and why it stopped.
		expect((error as LlmError).usage).toEqual({
			inputTokens: 120,
			outputTokens: 30,
			reasoningTokens: 25,
			finishReason: 'length',
			cost: null,
		});
		const [entry] = (await settings.activity()).entries;
		expect(entry).toMatchObject({
			errorCode: 'output_too_long',
			inputTokens: 120,
			outputTokens: 30,
			reasoningTokens: 25,
			finishReason: 'length',
		});
	});

	describe('reasoning', () => {
		const askWith = (reasoning?: 'off' | 'low' | 'medium' | 'high') =>
			llm.generateObject({
				role: 'smart',
				feature: 'test.extract',
				areas: ['test'],
				schema: Trip,
				prompt: 'School trip Friday',
				timeoutMs: CALL_TIMEOUT_MS,
				...(reasoning && { reasoning }),
			});

		it('sends nothing unless asked', async () => {
			await useModel('priced', 'openai-compatible');
			await askWith();
			expect(seen[0]?.body).not.toHaveProperty('reasoning_effort');
			expect(seen[0]?.body).not.toHaveProperty('reasoning');
			await useModel('priced');
			await askWith();
			expect(seen[1]?.body).not.toHaveProperty('reasoning_effort');
			expect(seen[1]?.body).not.toHaveProperty('reasoning');
		});

		it('sends reasoning_effort to OpenAI-compatible providers', async () => {
			await useModel('priced', 'openai-compatible');
			await askWith('low');
			expect(seen[0]?.body.reasoning_effort).toBe('low');
			await askWith('off');
			expect(seen[1]?.body.reasoning_effort).toBe('none');
			expect(seen[1]?.body).not.toHaveProperty('reasoning');
		});

		it('sends a reasoning object to OpenRouter', async () => {
			await useModel('priced');
			await askWith('low');
			expect(seen[0]?.body.reasoning).toEqual({ effort: 'low' });
			expect(seen[0]?.body).not.toHaveProperty('reasoning_effort');
			await askWith('off');
			expect(seen[1]?.body.reasoning).toEqual({ effort: 'none' });
		});

		it('asks again without it when the provider refuses the setting', async () => {
			await useModel('no-thinking', 'openai-compatible');
			await expect(askWith('low')).resolves.toMatchObject({ output: { title: 'Zoo trip' } });
			expect(seen).toHaveLength(2);
			expect(seen[0]?.body.reasoning_effort).toBe('low');
			expect(seen[1]?.body).not.toHaveProperty('reasoning_effort');
		});
	});

	describe('output modes', () => {
		const modes = async () =>
			(
				await aiTables(db)
					.selectFrom('ai_usage')
					.select(['output_mode', 'error_code'])
					.orderBy('id')
					.execute()
			).map((r) => `${r.output_mode}:${r.error_code ?? 'ok'}`);

		it('picks the mode by provider and model', () => {
			expect(outputModeFor('openrouter', 'openai/gpt-4.1-mini')).toBe('schema');
			expect(outputModeFor('openai-compatible', 'gpt-4.1')).toBe('schema');
			expect(outputModeFor('openrouter', 'google/gemini-2.5-flash')).toBe('json');
			// The prefix belongs to its provider: another server may host something else by the name.
			expect(outputModeFor('ollama', 'gpt-4.1')).toBe('json');
			expect(outputModeFor('ollama', 'qwen3:8b')).toBe('json');
		});

		it('gives a model that follows a JSON Schema the schema, and records the mode', async () => {
			await useModel('openai/gpt-4.1-mini');
			await expect(ask()).resolves.toMatchObject({ outputMode: 'schema' });
			expect(seen[0]?.body.response_format).toMatchObject({
				type: 'json_schema',
				json_schema: { strict: false },
			});
			expect(systemOf(seen[0])).toBe('');
			expect(await modes()).toEqual(['schema:ok']);
		});

		it('asks again for plain JSON when a model loops under the schema until the cap', async () => {
			await useModel('openai/gpt-4.1-loops');
			const result = await ask();
			expect(result).toMatchObject({
				output: { title: 'Zoo trip', date: '2026-10-17' },
				outputMode: 'json',
			});
			expect(seen.map((c) => (c.body.response_format as { type: string }).type)).toEqual([
				'json_schema',
				'json_object',
			]);
			// Both calls are counted, the failed one with why it failed.
			expect(await modes()).toEqual(['schema:output_too_long', 'json:ok']);
		});

		it('steps down when the provider refuses a mode, down to plain text', async () => {
			await useModel('openai/gpt-4.1-strict');
			await expect(ask()).resolves.toMatchObject({ outputMode: 'json' });
			expect(await modes()).toEqual(['schema:rejected', 'json:ok']);

			seen.length = 0;
			await useModel('plain-server', 'openai-compatible');
			await expect(ask()).resolves.toMatchObject({
				output: { title: 'Zoo trip', date: '2026-10-17' },
				outputMode: 'text',
			});
			expect(seen[1]?.body).not.toHaveProperty('response_format');
			expect(systemOf(seen[1])).toContain('JSON Schema');
		});

		it('keeps a forced mode, without falling back', async () => {
			await useModel('openai/gpt-4.1-loops');
			await expect(
				llm.generateObject({
					role: 'smart',
					feature: 'test.extract',
					areas: ['test'],
					schema: Trip,
					prompt: 'School trip Friday',
					timeoutMs: CALL_TIMEOUT_MS,
					output: 'schema',
				}),
			).rejects.toMatchObject({ code: 'output_too_long' });
			expect(seen).toHaveLength(1);
		});

		it('takes the JSON out of an answer with text around it', async () => {
			await useModel('talkative');
			await expect(ask()).resolves.toMatchObject({
				output: { title: 'Zoo trip {school}', date: '2026-10-17' },
			});
		});

		it('validates with the schema it was given, so a tolerant schema repairs the answer', async () => {
			await useModel('priced');
			const result = await llm.generateObject({
				role: 'smart',
				feature: 'test.extract',
				areas: ['test'],
				schema: Trip.extend({ confidence: z.number().catch(1) }),
				prompt: 'School trip Friday',
				timeoutMs: CALL_TIMEOUT_MS,
			});
			expect(result.output).toEqual({ title: 'Zoo trip', date: '2026-10-17', confidence: 1 });
			await expect(
				llm.generateObject({
					role: 'smart',
					feature: 'test.extract',
					areas: ['test'],
					schema: Trip.extend({ confidence: z.number() }),
					prompt: 'School trip Friday',
					timeoutMs: CALL_TIMEOUT_MS,
				}),
			).rejects.toMatchObject({
				code: 'invalid_output',
				message: expect.stringContaining('confidence'),
			});
		});

		it('records what an unusable answer cost, and keeps its text on the error', async () => {
			await useModel('priced-rambling');
			const error = await ask().catch((e: unknown) => e);
			expect(error).toMatchObject({
				code: 'invalid_output',
				usage: { cost: 0.00042 },
				cause: { text: 'not json at all' },
			});
			expect((await settings.usage()).total).toMatchObject({ calls: 1, errors: 1, cost: 0.00042 });
		});

		it('finds the JSON in an answer', () => {
			expect(extractJson('{"a":1}')).toEqual({ value: { a: 1 } });
			expect(extractJson('```json\n{"a":1}\n```')).toEqual({ value: { a: 1 } });
			expect(extractJson('Sure:\n```\n{"a":1}\n```\nDone')).toEqual({ value: { a: 1 } });
			expect(extractJson('<think>maybe {x}</think>\n{"a":"}{"}')).toEqual({ value: { a: '}{' } });
			expect(extractJson('I read {not json} and then {"a":[1,2]} end')).toEqual({
				value: { a: [1, 2] },
			});
			expect(extractJson('{"a":"say \\"hi\\" {"}')).toEqual({ value: { a: 'say "hi" {' } });
			// A complete answer followed by endless blank lines still counts.
			expect(extractJson(`{"a":1}${'\n'.repeat(50)}`)).toEqual({ value: { a: 1 } });
			// Cut off: a fragment inside is never taken for the whole answer.
			expect(extractJson('{"summary":"x","proposals":[{"action":"a","input":{"b":1}},{"act')).toBe(
				null,
			);
			expect(extractJson('no json here')).toBe(null);
			expect(extractJson('')).toBe(null);
		});
	});

	it('records the output mode on usage kept from before it existed', async () => {
		({ db } = openDatabase({ path: ':memory:' }));
		const { '0003_usage_output_mode': added, ...previous } = aiMigrations;
		expect(added).toBeDefined();
		await runMigrations(db, [{ scope: 'ai', migrations: previous }]);
		await aiTables(db)
			.insertInto('ai_usage')
			.values({
				id: 'ai_call_old',
				at: NOW,
				role: 'smart',
				provider_id: null,
				model: 'Old / m',
				feature: 'test.extract',
				member_id: null,
				job_id: null,
				input_tokens: null,
				output_tokens: null,
				reasoning_tokens: null,
				finish_reason: null,
				cost_micros: null,
				latency_ms: 5,
				error_code: null,
				areas: null,
			})
			.execute();
		await runMigrations(db, [{ scope: 'ai', migrations: aiMigrations }]);
		const rows = await aiTables(db).selectFrom('ai_usage').select(['id', 'output_mode']).execute();
		expect(rows).toEqual([{ id: 'ai_call_old', output_mode: null }]);
	});

	it('stops at the monthly limits', async () => {
		await useModel('priced');
		await settings.setLimits({ monthlyCostLimit: null, monthlyCallLimit: 1 });
		await ask();
		const error = await ask().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(LlmError);
		expect(error).toMatchObject({ code: 'limit_reached' });
		await settings.setLimits({ monthlyCostLimit: 0.0004, monthlyCallLimit: null });
		await expect(ask()).rejects.toMatchObject({ code: 'limit_reached' });
	});
});

describe('embeddings', () => {
	const embed = (area = 'test', texts: string[] = ['one', 'three']) =>
		llm.embed({ feature: 'test.embed', area, texts, timeoutMs: CALL_TIMEOUT_MS, jobId: 'job_1' });
	async function useEmbedder(
		model: string,
		kind: 'openai-compatible' | 'ollama' = 'openai-compatible',
	) {
		const provider = await settings.createProvider({
			name: 'Embedder',
			kind,
			baseUrl,
			apiKey: 'good-key',
		});
		await settings.setRoles({
			...(await settings.roles()),
			embed: { providerId: provider.id, model },
		});
		return provider;
	}

	it('returns one vector per text, names the model and records the call', async () => {
		const provider = await useEmbedder('embed-ok');
		const result = await embed();
		expect(result.dimensions).toBe(4);
		expect(result.model).toBe(`${provider.id}:embed-ok`);
		expect(result.vectors.map((v) => [...v])).toEqual([
			[3, 1, 0, 0],
			[5, 1, 0, 0],
		]);
		expect(seen[0]).toMatchObject({
			url: '/v1/embeddings',
			auth: 'Bearer good-key',
			body: { model: 'embed-ok', input: ['one', 'three'] },
		});
		const row = await db
			.selectFrom('ai_usage' as never)
			.select(['role', 'feature', 'input_tokens', 'job_id', 'areas'] as never[])
			.executeTakeFirstOrThrow();
		expect(row).toMatchObject({
			role: 'embed',
			feature: 'test.embed',
			input_tokens: 7,
			job_id: 'job_1',
			areas: '["test"]',
		});
	});

	it('puts the stable model key in the policy', async () => {
		expect((await llm.policy('search', 'embed')).model).toBeNull();
		const provider = await useEmbedder('embed-ok');
		expect((await llm.policy('search', 'embed')).model).toBe(`${provider.id}:embed-ok`);
	});

	it('needs a model for the role', async () => {
		await expect(embed()).rejects.toMatchObject({ code: 'not_configured', retryable: false });
		expect(seen).toHaveLength(0);
	});

	it('follows the area rules without a fallback', async () => {
		dns['cloud.example.test'] = ['93.184.216.34'];
		const provider = await settings.createProvider({
			name: 'Cloud',
			kind: 'openai-compatible',
			baseUrl: `http://cloud.example.test:${new URL(baseUrl).port}/v1`,
			apiKey: 'good-key',
		});
		await settings.setRoles({
			...(await settings.roles()),
			embed: { providerId: provider.id, model: 'embed-ok' },
		});
		areas.inbox = 'off';
		await expect(embed('inbox')).rejects.toMatchObject({ code: 'disabled' });
		areas.inbox = 'local';
		await expect(embed('inbox')).rejects.toMatchObject({ code: 'local_required' });
		expect(seen).toHaveLength(0);
	});

	it('respects the switches and the monthly limit', async () => {
		await useEmbedder('embed-ok');
		await settings.setSwitches({ enabled: true, off: ['test.embed'] });
		await expect(embed()).rejects.toMatchObject({ code: 'disabled' });
		await settings.setSwitches({ enabled: true, off: [] });
		await settings.setLimits({ monthlyCostLimit: null, monthlyCallLimit: 1 });
		await embed();
		await expect(embed()).rejects.toMatchObject({ code: 'limit_reached' });
	});

	it('maps failures to error codes and records them', async () => {
		await useEmbedder('embed-denied');
		await expect(embed()).rejects.toMatchObject({ code: 'auth', retryable: false });
		await useEmbedder('embed-down');
		await expect(
			llm.embed({ feature: 'test.embed', area: 'test', texts: ['a'], timeoutMs: 10_000 }),
		).rejects.toMatchObject({ code: 'unavailable', retryable: true });
		await useEmbedder('embed-short');
		await expect(embed()).rejects.toMatchObject({ code: 'invalid_output' });
	});
});

describe('speech to text', () => {
	it('posts the audio to the transcription endpoint and records the call', async () => {
		await useTranscriber('priced-stt');
		const result = await say();
		expect(result).toMatchObject({
			text: 'Ayşe will pick up Elif at four.',
			model: 'Speech / priced-stt',
			usage: { cost: 0.0006 },
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			url: '/v1/audio/transcriptions',
			auth: 'Bearer good-key',
			body: {
				model: 'priced-stt',
				language: 'tr',
				response_format: 'json',
				filename: 'voice.ogg',
				contentType: 'audio/ogg',
			},
		});
		const usage = await settings.usage();
		expect(usage).toMatchObject({
			total: { calls: 1, errors: 0, cost: 0.0006 },
			byFeature: [{ key: 'test.transcribe', calls: 1 }],
		});
		const row = await db
			.selectFrom('ai_usage' as never)
			.select(['role', 'member_id', 'job_id'] as never[])
			.executeTakeFirstOrThrow();
		expect(row).toMatchObject({ role: 'transcribe', member_id: 'mem_1', job_id: 'job_1' });
	});

	it('leaves the cost empty when the provider reports none, and omits an unset language', async () => {
		await useTranscriber('plain-stt');
		const result = await llm.transcribe({
			feature: 'test.transcribe',
			areas: ['test'],
			audio,
			mediaType: 'audio/mpeg',
			filename: 'note.mp3',
			timeoutMs: CALL_TIMEOUT_MS,
		});
		expect(result.usage.cost).toBeNull();
		expect(seen[0]?.body.language).toBeUndefined();
	});

	it('needs a model for the role, and not an Ollama provider', async () => {
		await expect(say()).rejects.toMatchObject({ code: 'not_configured', retryable: false });
		await useTranscriber('whisper', 'ollama');
		await expect(say()).rejects.toMatchObject({ code: 'not_configured', retryable: false });
		expect(seen).toHaveLength(0);
	});

	it('respects the switches and the voice privacy setting', async () => {
		await useTranscriber('plain-stt');
		await settings.setSwitches({ enabled: true, off: ['test.transcribe'] });
		await expect(say()).rejects.toMatchObject({ code: 'disabled', retryable: false });
		await settings.setSwitches({ enabled: true, off: [] });
		await settings.setPrivacy({ ...(await settings.privacy()), sendVoice: false });
		expect((await llm.policy('test.transcribe', 'transcribe')).sendVoice).toBe(false);
		await expect(say()).rejects.toMatchObject({ code: 'disabled', retryable: false });
		expect(seen).toHaveLength(0);
		await settings.setPrivacy({ ...(await settings.privacy()), sendVoice: true });
		await expect(say()).resolves.toMatchObject({ model: 'Speech / plain-stt' });
	});

	it('maps provider errors to codes and records failures', async () => {
		await useTranscriber('denied-stt');
		await expect(say()).rejects.toMatchObject({ code: 'auth', retryable: false });
		await useTranscriber('big-stt');
		await expect(say()).rejects.toMatchObject({ code: 'rejected', retryable: false });
		await useTranscriber('missing-stt');
		await expect(say()).rejects.toMatchObject({ code: 'not_configured', retryable: false });
		await useTranscriber('down-stt');
		await expect(say()).rejects.toMatchObject({ code: 'unavailable', retryable: true });
		await useTranscriber('slow-stt');
		await expect(say(200)).rejects.toMatchObject({ code: 'timeout', retryable: true });
		expect((await settings.usage()).total).toMatchObject({ calls: 5, errors: 5 });
	});

	it('counts toward the monthly call limit', async () => {
		await useTranscriber('plain-stt');
		await settings.setLimits({ monthlyCostLimit: null, monthlyCallLimit: 1 });
		await say();
		await expect(say()).rejects.toMatchObject({ code: 'limit_reached' });
	});

	it('reads settings stored before voice notes existed with defaults', async () => {
		const now = Date.now();
		await db
			.insertInto('ai_settings' as never)
			.values([
				{
					key: 'privacy',
					value: JSON.stringify({ sendFiles: false, sendPeople: true, zeroRetention: true }),
					updated_at: now,
				},
				{
					key: 'roles',
					value: JSON.stringify({ fast: null, vision: null, smart: null }),
					updated_at: now,
				},
			] as never)
			.execute();
		expect(await settings.privacy()).toEqual({
			sendFiles: false,
			sendPeople: true,
			sendVoice: true,
			zeroRetention: true,
		});
		expect((await settings.roles()).transcribe).toBeNull();
		expect((await settings.get()).roles).toMatchObject({ transcribe: null });
	});
});

describe('AI areas and local models', () => {
	const row = () =>
		db
			.selectFrom('ai_usage' as never)
			.select(['feature', 'error_code', 'model'] as never[])
			.execute() as Promise<{ feature: string; error_code: string | null; model: string }[]>;

	/** A provider at a host name that the injected resolver maps to `addresses`. */
	async function useProviderAt(host: string, addresses: string[]) {
		dns[host] = addresses;
		const port = new URL(baseUrl).port;
		const provider = await settings.createProvider({
			name: 'Named',
			kind: 'openai-compatible',
			baseUrl: `http://${host}:${port}/v1`,
			apiKey: 'good-key',
		});
		await settings.setRoles({
			...(await settings.roles()),
			smart: { providerId: provider.id, model: 'priced' },
		});
		return provider;
	}

	it('refuses an area that is off, records it, and never reaches the provider', async () => {
		await useModel('priced');
		areas.vault = 'off';
		await expect(
			llm.generateObject({
				role: 'smart',
				feature: 'test.extract',
				areas: ['test', 'vault'],
				schema: Trip,
				prompt: 'x',
				timeoutMs: CALL_TIMEOUT_MS,
			}),
		).rejects.toMatchObject({ code: 'disabled', retryable: false });
		expect(seen).toHaveLength(0);
		expect(await row()).toEqual([
			{ feature: 'test.extract', error_code: 'disabled', model: 'Router / priced' },
		]);
	});

	it('refuses a local-only area when the provider resolves to a public address', async () => {
		await useProviderAt('models.example.test', ['93.184.216.34']);
		areas.vault = 'local';
		await expect(
			llm.generateObject({
				role: 'smart',
				feature: 'test.extract',
				areas: ['vault'],
				schema: Trip,
				prompt: 'x',
				timeoutMs: CALL_TIMEOUT_MS,
			}),
		).rejects.toMatchObject({ code: 'local_required', retryable: false });
		expect(seen).toHaveLength(0);
		expect((await row())[0]).toMatchObject({ error_code: 'local_required' });
	});

	it('does not fall back when a name resolves to a public and a local address', async () => {
		await useProviderAt('mixed.example.test', ['192.168.1.20', '93.184.216.34']);
		areas.vault = 'local';
		await expect(
			llm.generateObject({
				role: 'smart',
				feature: 'test.extract',
				areas: ['vault'],
				schema: Trip,
				prompt: 'x',
				timeoutMs: CALL_TIMEOUT_MS,
			}),
		).rejects.toMatchObject({ code: 'local_required' });
		expect(seen).toHaveLength(0);
	});

	it('allows a local-only area on a local provider, whatever its kind', async () => {
		// The stand-in server listens on loopback: a local address, though the kind is OpenRouter.
		await useModel('priced', 'openrouter');
		areas.vault = 'local';
		await expect(
			llm.generateObject({
				role: 'smart',
				feature: 'test.extract',
				areas: ['test', 'vault'],
				schema: Trip,
				prompt: 'x',
				timeoutMs: CALL_TIMEOUT_MS,
			}),
		).resolves.toMatchObject({ model: 'Router / priced' });
		expect(seen).toHaveLength(1);
	});

	it('allows any-provider areas on public providers', async () => {
		await useProviderAt('models.example.test', ['93.184.216.34']);
		// `.test` is reserved (RFC 6761) and never resolves, so the call fails at the network
		// deterministically, after passing the area check: no area error.
		const error = await ask().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(LlmError);
		expect((error as LlmError).code).not.toBe('local_required');
		expect((error as LlmError).code).not.toBe('disabled');
	});

	it('refuses a transcription for a local-only area on a public provider', async () => {
		dns['stt.example.test'] = ['93.184.216.34'];
		const provider = await settings.createProvider({
			name: 'Speech',
			kind: 'openai-compatible',
			baseUrl: `http://stt.example.test:${new URL(baseUrl).port}/v1`,
			apiKey: 'good-key',
		});
		await settings.setRoles({
			...(await settings.roles()),
			transcribe: { providerId: provider.id, model: 'plain-stt' },
			embed: null,
		});
		areas.inbox = 'local';
		await expect(
			llm.transcribe({
				feature: 'test.transcribe',
				areas: ['inbox'],
				audio,
				mediaType: 'audio/ogg',
				filename: 'v.ogg',
				timeoutMs: CALL_TIMEOUT_MS,
			}),
		).rejects.toMatchObject({ code: 'local_required' });
		expect(seen).toHaveLength(0);
		areas.inbox = 'off';
		await expect(
			llm.transcribe({
				feature: 'test.transcribe',
				areas: ['inbox'],
				audio,
				mediaType: 'audio/ogg',
				filename: 'v.ogg',
				timeoutMs: CALL_TIMEOUT_MS,
			}),
		).rejects.toMatchObject({ code: 'disabled' });
		expect((await row()).map((r) => r.error_code)).toEqual(['local_required', 'disabled']);
	});

	it('reports whether the provider of a role is local in the policy', async () => {
		expect((await llm.policy('test.extract', 'smart')).local).toBe(false);
		await useProviderAt('ollama.lan', ['192.168.1.20']);
		expect((await llm.policy('test.extract', 'smart')).local).toBe(true);
		// Other roles have their own provider.
		expect((await llm.policy('test.extract', 'vision')).local).toBe(false);
		// The answer is cached for a minute, then asked again.
		dns['ollama.lan'] = ['93.184.216.34'];
		expect((await llm.policy('test.extract', 'smart')).local).toBe(true);
		clockNow += 61_000;
		expect((await llm.policy('test.extract', 'smart')).local).toBe(false);
		expect((await settings.get()).providers[0]).toMatchObject({ local: false });
	});

	it('does not count a name that does not resolve as local', async () => {
		await useProviderAt('gone.example.test', []);
		expect((await llm.policy('test.extract', 'smart')).local).toBe(false);
	});
});

describe('AI activity', () => {
	it('records the areas of every call, including refused ones, and lists them newest first', async () => {
		await useModel('priced');
		await ask();
		areas.vault = 'off';
		await expect(
			llm.generateObject({
				role: 'smart',
				feature: 'test.extract',
				areas: ['test', 'vault', 'test'],
				schema: Trip,
				prompt: 'secret prompt text',
				timeoutMs: CALL_TIMEOUT_MS,
				memberId: 'mem_9',
			}),
		).rejects.toMatchObject({ code: 'disabled' });
		await useTranscriber('plain-stt');
		await say();

		const { entries, next } = await settings.activity();
		expect(next).toBeNull();
		expect(entries.map((e) => [e.feature, e.areas, e.errorCode])).toEqual(
			expect.arrayContaining([
				['test.extract', ['test'], null],
				['test.extract', ['test', 'vault'], 'disabled'],
				['test.transcribe', ['test'], null],
			]),
		);
		expect(entries).toHaveLength(3);
		const refused = entries.find((e) => e.errorCode === 'disabled');
		expect(refused).toMatchObject({ provider: 'Router', model: 'priced', memberId: 'mem_9' });
		// Nothing of the prompt or the answer is stored or returned.
		expect(JSON.stringify(entries)).not.toContain('secret prompt text');
		expect(JSON.stringify(entries)).not.toContain('Zoo trip');
	});

	it('pages with a cursor and reads rows without areas as unknown', async () => {
		await useModel('priced');
		for (let i = 0; i < 3; i++) {
			clockNow += 1_000;
			await ask();
		}
		await db
			.updateTable('ai_usage' as never)
			.set({ areas: null } as never)
			.where('at' as never, '=', (NOW + 1_000) as never)
			.execute();
		const first = await settings.activity({ limit: 2 });
		expect(first.entries.map((e) => e.at)).toEqual([NOW + 3_000, NOW + 2_000]);
		expect(first.next).not.toBeNull();
		const rest = await settings.activity({ limit: 2, before: first.next as string });
		expect(rest.entries.map((e) => e.at)).toEqual([NOW + 1_000]);
		expect(rest.entries[0]?.areas).toBeNull();
		expect(rest.next).toBeNull();
	});
});

describe('chat with tools', () => {
	const usage = () =>
		db
			.selectFrom('ai_usage' as never)
			.select([
				'feature',
				'error_code',
				'areas',
				'input_tokens',
				'output_tokens',
				'cost_micros',
			] as never[])
			.execute() as Promise<
			{
				feature: string;
				error_code: string | null;
				areas: string;
				input_tokens: number;
				output_tokens: number;
				cost_micros: number | null;
			}[]
		>;
	const executed: unknown[] = [];
	const ping = {
		name: 'ping',
		description: 'Pings',
		inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
		async execute(input: unknown) {
			executed.push(input);
			return 'pong 1';
		},
	};
	const chat = (overrides: Partial<Parameters<LlmPort['chat']>[0]> = {}) => {
		const deltas: string[] = [];
		const run = llm.chat({
			role: 'smart',
			feature: 'assistant.chat',
			areas: ['assistant', 'calendar'],
			system: 'You help.',
			messages: [{ role: 'user', content: 'ping?' }],
			tools: [ping],
			maxSteps: 4,
			timeoutMs: CALL_TIMEOUT_MS,
			memberId: 'mem_1',
			jobId: 'job_1',
			onText: (d) => deltas.push(d),
			...overrides,
		});
		return { run, deltas };
	};
	beforeEach(() => {
		executed.length = 0;
	});

	it('runs the tool loop, streams the answer and records one usage row with the areas', async () => {
		await useModel('chat-tools');
		const calls: string[] = [];
		const { run, deltas } = chat({
			onToolCall: (name) => calls.push(`call ${name}`),
			onToolResult: (name, ok) => calls.push(`result ${name} ${ok}`),
		});
		const result = await run;
		expect(result).toMatchObject({
			text: 'Pong: pong 1',
			toolCalls: [{ name: 'ping', ok: true }],
			model: 'Router / chat-tools',
			usage: { inputTokens: 200, outputTokens: 20 },
		});
		expect(executed).toEqual([{ x: 1 }]);
		expect(calls).toEqual(['call ping', 'result ping true']);
		expect(deltas.join('')).toBe('Pong: pong 1');
		expect(deltas.length).toBeGreaterThan(1);
		// The request carried the tool as a JSON Schema function, and the system prompt.
		const first = seen[0]?.body as {
			tools: { function: { name: string } }[];
			messages: { role: string }[];
		};
		expect(first.tools.map((t) => t.function.name)).toEqual(['ping']);
		// No temperature asked for: the provider's default.
		expect((first as { temperature?: number }).temperature).toBeUndefined();
		expect(first.messages[0]).toMatchObject({ role: 'system', content: 'You help.' });
		expect(await usage()).toEqual([
			{
				feature: 'assistant.chat',
				error_code: null,
				areas: '["assistant","calendar"]',
				input_tokens: 200,
				output_tokens: 20,
				cost_micros: null,
			},
		]);
	});

	it('passes the temperature on to every step of the tool loop', async () => {
		await useModel('chat-tools');
		await chat({ temperature: 0 }).run;
		const bodies = seen.map((s) => s.body as { temperature?: number });
		expect(bodies.length).toBeGreaterThan(1);
		for (const body of bodies) expect(body.temperature).toBe(0);
	});

	it('records a call to a tool that was not offered as failed, and still answers', async () => {
		await useModel('chat-unknown');
		const result = await chat({}).run;
		expect(result.toolCalls).toEqual([{ name: 'nope', ok: false }]);
		expect(executed).toEqual([]);
	});

	it('reports a failing tool to the model and records it as not ok', async () => {
		await useModel('chat-tools');
		const failing = { ...ping, execute: async () => Promise.reject(new Error('boom')) };
		const result = await chat({ tools: [failing] }).run;
		expect(result.toolCalls).toEqual([{ name: 'ping', ok: false }]);
		expect(result.text).toBe('Pong: Error: boom');
	});

	it('stops at the step limit without an answer', async () => {
		await useModel('chat-loop');
		const result = await chat({ maxSteps: 3 }).run;
		expect(executed).toHaveLength(3);
		expect(result.text).toBe('');
		expect(result.toolCalls).toHaveLength(3);
	});

	it('sums the reported cost', async () => {
		await useModel('chat-priced');
		await chat().run;
		expect((await usage())[0]?.cost_micros).toBe(2_000);
	});

	it('refuses an area that is off, and a local-only one on a public provider', async () => {
		await useModel('chat-tools');
		areas.vault = 'off';
		await expect(chat({ areas: ['assistant', 'vault'] }).run).rejects.toMatchObject({
			code: 'disabled',
			retryable: false,
		});
		expect(seen).toHaveLength(0);
		expect((await usage())[0]).toMatchObject({
			error_code: 'disabled',
			areas: '["assistant","vault"]',
		});

		areas.vault = 'local';
		dns['models.example.test'] = ['93.184.216.34'];
		const provider = await settings.createProvider({
			name: 'Named',
			kind: 'openai-compatible',
			baseUrl: `http://models.example.test:${new URL(baseUrl).port}/v1`,
			apiKey: 'good-key',
		});
		await settings.setRoles({
			...(await settings.roles()),
			smart: { providerId: provider.id, model: 'chat-tools' },
		});
		await expect(chat({ areas: ['vault'] }).run).rejects.toMatchObject({
			code: 'local_required',
		});
		expect(seen).toHaveLength(0);
	});

	it('honours the AI switches and the monthly limit', async () => {
		await useModel('chat-tools');
		await settings.setSwitches({ enabled: true, off: ['assistant.chat'] });
		await expect(chat().run).rejects.toMatchObject({ code: 'disabled' });
		await settings.setSwitches({ enabled: true, off: [] });
		await settings.setLimits({ monthlyCallLimit: 1, monthlyCostLimit: null });
		await chat().run;
		await expect(chat().run).rejects.toMatchObject({ code: 'limit_reached' });
	});

	it('maps provider failures to error codes and records them', async () => {
		await useModel('chat-down');
		await expect(chat({ timeoutMs: 10_000 }).run).rejects.toMatchObject({
			code: 'unavailable',
			retryable: true,
		});
		expect((await usage())[0]).toMatchObject({ error_code: 'unavailable' });

		await expect(chat({ timeoutMs: 50 }).run).rejects.toMatchObject({ code: 'timeout' });
	});
});
