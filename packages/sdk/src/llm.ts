import type { z } from 'zod';
import { hasBrand } from './errors.ts';

/**
 * Language models. Extensions ask for a *role*, never a provider or model: the
 * family maps roles to models in the admin UI. Only background jobs receive an `LlmPort`
 * (`JobContext.llm`), so no HTTP request can wait on a model.
 */
export const MODEL_ROLES = ['fast', 'vision', 'smart', 'transcribe', 'embed'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * How far the AI may use one area, an extension's data and actions. `local` means only
 * through models on the family's own network. Set per extension in Settings → AI.
 */
export const AI_AREA_ACCESS = ['off', 'local', 'any'] as const;
export type AiAreaAccess = (typeof AI_AREA_ACCESS)[number];

export interface LlmFile {
	data: Uint8Array;
	/** `image/png`, `image/jpeg`, `application/pdf` … Images need a vision-capable model. */
	mediaType: string;
}

/**
 * How a model is asked for structured output. `schema` hands the provider the JSON Schema to
 * constrain decoding with; `json` asks for any JSON object and describes the schema in the
 * prompt; `text` asks for nothing and takes the JSON out of the answer, for servers that refuse
 * both. Every mode validates the answer against the request's `schema` itself.
 */
export const OUTPUT_MODES = ['schema', 'json', 'text'] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];

export interface LlmObjectRequest<T> {
	role: ModelRole;
	/** What the call is for, recorded in usage, e.g. `inbox.extract`. */
	feature: string;
	/**
	 * The areas (extension ids) whose data or actions the call carries, the feature's own
	 * extension included. The adapter refuses the call when one is off for the AI, or local-only
	 * and the role's provider is not local.
	 */
	areas: readonly string[];
	/**
	 * The structured output; the result is validated against it in every output mode. Make it
	 * tolerant (defaults, `.catch`) where one bad field should not throw the whole answer away.
	 */
	schema: z.ZodType<T>;
	/**
	 * The JSON Schema shown to the model, when it should be more detailed than `schema`. Use it
	 * to describe nested shapes precisely while validating them loosely (and one by one) yourself.
	 */
	jsonSchema?: Record<string, unknown>;
	system?: string;
	prompt: string;
	files?: readonly LlmFile[];
	/** Required: every model call has an explicit time limit. */
	timeoutMs: number;
	/**
	 * The most tokens the model may write, reasoning included on models that count it. A model
	 * that rambles would otherwise run until the time limit; when the cap cuts the answer off the
	 * call fails with `output_too_long`, which retrying does not fix.
	 */
	maxOutputTokens?: number;
	/**
	 * How freely the model chooses its words (0 = always the most likely). Left out, the
	 * provider's default applies, which for many models is high enough that the same input gets
	 * a different answer each time; reading data out of text wants 0.
	 */
	temperature?: number;
	/**
	 * How much the model may think before it answers, on models that can. Left out, the
	 * provider's default applies. Reading data out of text wants little or none: thinking counts
	 * against `maxOutputTokens` and can fill it before the answer starts. A provider that
	 * refuses the setting is asked again without it.
	 */
	reasoning?: LlmReasoning;
	/**
	 * Forces one output mode, with no fallback (an evaluation comparing modes). Left out, the
	 * adapter picks the mode that works best for the provider and model, and steps down to the
	 * next one when the provider refuses it or its answer cannot be used.
	 */
	output?: OutputMode;
	/** Recorded in usage. */
	memberId?: string | null;
	jobId?: string | null;
}

export const LLM_REASONING = ['off', 'low', 'medium', 'high'] as const;
export type LlmReasoning = (typeof LLM_REASONING)[number];

/** One message of a chat. Tool results are data, never instructions. */
export interface LlmChatMessage {
	role: 'user' | 'assistant' | 'tool';
	content: string;
	/** Tool messages: which call the result answers, and which tool it was. */
	toolCallId?: string;
	toolName?: string;
}

/** A function the model may call during a chat. `execute` runs in this process, never remotely. */
export interface LlmChatTool {
	/** Letters, digits, `_` and `-` only (providers reject dots); the caller maps names back. */
	name: string;
	description: string;
	/** JSON Schema of the input. */
	inputSchema: Record<string, unknown>;
	/**
	 * Runs the call. The result is shown to the model as is (serialised when not a string); a
	 * thrown error is shown as a failed call so the model can recover.
	 */
	execute(input: unknown): Promise<unknown>;
}

export interface LlmChatRequest {
	role: ModelRole;
	/** What the call is for, recorded in usage, e.g. `assistant.chat`. */
	feature: string;
	/** The areas whose data or actions the call carries (see `LlmObjectRequest.areas`). */
	areas: readonly string[];
	system?: string;
	messages: readonly LlmChatMessage[];
	tools: readonly LlmChatTool[];
	/**
	 * The most model round trips (a round trip that calls tools is one step). The last one gets no
	 * tools, nor does any step once most of `timeoutMs` is gone: the loop ends with an answer.
	 */
	maxSteps: number;
	/**
	 * Asked before each step: once it returns true the model gets no tools and must answer
	 * from what it has (a host limit on tool calls was reached).
	 */
	toolsClosed?(): boolean;
	/** Required: every model call has an explicit time limit (for the whole tool loop). */
	timeoutMs: number;
	/**
	 * How freely the model chooses its words and its tool calls, for every step of the loop (see
	 * `LlmObjectRequest.temperature`). Left out, the provider's default applies.
	 */
	temperature?: number;
	memberId?: string | null;
	jobId?: string | null;
	/** Streamed answer text, in order. */
	onText?(delta: string): void;
	onToolCall?(name: string, input: unknown): void;
	onToolResult?(name: string, ok: boolean): void;
}

export interface LlmChatResult {
	/** The final answer. Empty when the step limit ended the loop on a tool call. */
	text: string;
	toolCalls: { name: string; ok: boolean }[];
	/** `provider name / model`, for display and debugging. */
	model: string;
	usage: LlmUsage;
}

export interface LlmTranscribeRequest {
	/** What the call is for, recorded in usage, e.g. `inbox.transcribe`. */
	feature: string;
	/** The areas the audio comes from (see `LlmObjectRequest.areas`). */
	areas: readonly string[];
	audio: Uint8Array;
	/** `audio/ogg`, `audio/mpeg`, `audio/mp4` … */
	mediaType: string;
	/** Some servers decide the format from the file name. */
	filename: string;
	/** ISO 639-1 hint, for example the family language. */
	language?: string;
	/** Required: every model call has an explicit time limit. */
	timeoutMs: number;
	memberId?: string | null;
	jobId?: string | null;
}

export interface LlmTranscribeResult {
	text: string;
	/** `provider name / model`, for display and debugging. */
	model: string;
	usage: LlmUsage;
}

export interface LlmEmbedRequest {
	/** What the call is for, recorded in usage, e.g. `search` or `core.embed`. */
	feature: string;
	/**
	 * The area (extension id) the texts come from; `core` for a search query. The adapter refuses
	 * the call when the area is off for the AI, or local-only and the `embed` provider is not
	 * local.
	 */
	area: string;
	texts: readonly string[];
	/** Required: every model call has an explicit time limit. */
	timeoutMs: number;
	memberId?: string | null;
	jobId?: string | null;
}

export interface LlmEmbedResult {
	/** One vector per text, in order. */
	vectors: Float32Array[];
	/**
	 * A stable key of the model that made them (`<provider id>:<model>`): vectors of different
	 * keys must never be compared, so a change of the model rebuilds the index.
	 */
	model: string;
	dimensions: number;
}

export interface LlmUsage {
	inputTokens: number | null;
	outputTokens: number | null;
	/** The part of the output spent on thinking, when the provider reports it. */
	reasoningTokens?: number | null;
	/** USD, when the provider reports it (OpenRouter); local models cost 0. */
	cost: number | null;
}

export interface LlmObjectResult<T> {
	output: T;
	/** `provider name / model`, for display and debugging. */
	model: string;
	/** The output mode that gave the answer, when the port knows it. */
	outputMode?: OutputMode;
	usage: LlmUsage;
}

/**
 * What the family lets the AI see (Settings → AI). Callers build their prompts accordingly; the
 * adapter also drops files itself when they are not allowed.
 */
export interface LlmPolicy {
	/** AI is on, and so is this feature (Settings → AI). When false, calls fail with `disabled`. */
	enabled: boolean;
	/** Photos and documents may be sent to the model. */
	sendFiles: boolean;
	/** Member names and "about" texts may be sent; otherwise only handles like `member:1`. */
	sendPeople: boolean;
	/** Voice notes may be sent to the speech-to-text model. */
	sendVoice: boolean;
	/**
	 * The provider of the role asked about runs on the family's own network (its address resolves
	 * only to local addresses). Callers use it to decide which areas they may draw from.
	 */
	local: boolean;
	/**
	 * The stable key (`<provider id>:<model>`, as in `LlmEmbedResult.model`) of the model set for
	 * the role asked about, or null when none is set.
	 */
	model: string | null;
}

export interface LlmPort {
	generateObject<T>(request: LlmObjectRequest<T>): Promise<LlmObjectResult<T>>;
	/**
	 * A chat with tools: the model may call the tools, in a loop of at most `maxSteps`
	 * round trips, and answers in text. Same rules as `generateObject` (switches, limits, areas,
	 * usage). Usage is recorded once for the whole loop.
	 */
	chat(request: LlmChatRequest): Promise<LlmChatResult>;
	/**
	 * Turns speech into text with the `transcribe` role. Same rules as `generateObject` (switches,
	 * limits, usage); fails with `disabled` when the family does not send voice notes.
	 */
	transcribe(request: LlmTranscribeRequest): Promise<LlmTranscribeResult>;
	/**
	 * Turns texts into vectors with the `embed` role, for search. Same rules as
	 * `generateObject` (switches, limits, area access, usage); no fallback to another provider.
	 */
	embed(request: LlmEmbedRequest): Promise<LlmEmbedResult>;
	/**
	 * The family's choices for one feature (the `feature` named in requests), and whether the
	 * provider of the model `role` the feature will use is local.
	 */
	policy(feature: string, role: ModelRole): Promise<LlmPolicy>;
}

/**
 * Why a model call failed. `retryable` tells a job whether trying again later can help
 * (timeouts, outages) or whether a person must act first (no model set, bad key, limit reached).
 */
export type LlmErrorCode =
	| 'not_configured'
	/** The provider does not know the chosen model: a person must choose another. */
	| 'model_not_found'
	/** AI, or this feature, is turned off. */
	| 'disabled'
	| 'limit_reached'
	| 'auth'
	/** The provider refused the request itself (for example a schema it cannot handle). */
	| 'rejected'
	/** No provider of the model meets the family's data policy (zero data retention). */
	| 'data_policy'
	/** The area may only use local models, and the role's provider is not local (no fallback). */
	| 'local_required'
	| 'timeout'
	| 'unavailable'
	| 'invalid_output'
	/** The answer hit the request's `maxOutputTokens` before it was complete. */
	| 'output_too_long';

/** What a failed call used before it failed, when the provider said. */
export interface LlmFailureUsage {
	inputTokens: number | null;
	outputTokens: number | null;
	reasoningTokens: number | null;
	/** Why the model stopped (`length`, `stop` …). */
	finishReason: string | null;
	/** USD, when the provider reported it for an answer that could not be used. */
	cost?: number | null;
}

const RETRYABLE: ReadonlySet<LlmErrorCode> = new Set(['timeout', 'unavailable', 'invalid_output']);

const LLM_ERROR = Symbol.for('famos.LlmError');

export class LlmError extends Error {
	readonly [LLM_ERROR] = true;
	readonly code: LlmErrorCode;
	readonly retryable: boolean;
	/** Set on failures after the model had answered (cut off, unusable). */
	readonly usage: LlmFailureUsage | undefined;
	/** How long the provider asked to wait before the next call (a rate limit), when it said. */
	readonly retryAfterMs: number | undefined;

	constructor(
		code: LlmErrorCode,
		message: string,
		options?: { cause?: unknown; usage?: LlmFailureUsage; retryAfterMs?: number },
	) {
		super(message, options);
		this.usage = options?.usage;
		this.retryAfterMs = options?.retryAfterMs;
		this.name = 'LlmError';
		this.code = code;
		this.retryable = RETRYABLE.has(code);
	}
}

export const isLlmError = (error: unknown): error is LlmError => hasBrand(error, LLM_ERROR);
