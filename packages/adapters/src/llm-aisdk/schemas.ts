import { z } from 'zod';

/**
 * AI settings shapes, shared by the adapter and the admin API. Provider kinds are presets over
 * one OpenAI-compatible client: OpenRouter, a local Ollama, or any compatible server.
 */
export const PROVIDER_KINDS = ['openrouter', 'ollama', 'openai-compatible'] as const;
export const ProviderKindSchema = z.enum(PROVIDER_KINDS);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const DEFAULT_BASE_URLS: Record<ProviderKind, string | null> = {
	openrouter: 'https://openrouter.ai/api/v1',
	ollama: 'http://localhost:11434/v1',
	'openai-compatible': null,
};

const BaseUrlSchema = z
	.url({ protocol: /^https?$/ })
	.max(300)
	.transform((u) => u.replace(/\/+$/, ''));

export const ProviderSchema = z.object({
	id: z.string(),
	name: z.string(),
	kind: ProviderKindSchema,
	baseUrl: z.string(),
	/** A key is stored (never returned). */
	hasKey: z.boolean(),
	/** False when the stored key cannot be decrypted (FAMOS_SECRET changed): enter it again. */
	keyReadable: z.boolean(),
	/** The address resolves only to local addresses: the family's own network. */
	local: z.boolean(),
	/** Set by the server configuration (`FAMOS_AI_*`): read-only here, changed on restart. */
	managed: z.boolean(),
});
export type Provider = z.infer<typeof ProviderSchema>;

/** The fixed id of the provider kept in line with `FAMOS_AI_*`. */
export const ENV_PROVIDER_ID = 'ai_provider_env';

export const ProviderInputSchema = z.object({
	name: z.string().trim().min(1).max(60),
	kind: ProviderKindSchema,
	/** Defaults to the kind's usual address. */
	baseUrl: BaseUrlSchema.optional(),
	apiKey: z.string().trim().min(1).max(500).optional(),
});
export type ProviderInput = z.input<typeof ProviderInputSchema>;

export const ProviderPatchSchema = z.object({
	name: z.string().trim().min(1).max(60).optional(),
	baseUrl: BaseUrlSchema.optional(),
	/** A new key, or null to remove the stored one. */
	apiKey: z.string().trim().min(1).max(500).nullable().optional(),
});
export type ProviderPatch = z.input<typeof ProviderPatchSchema>;

export const RoleModelSchema = z.object({
	providerId: z.string(),
	model: z.string().trim().min(1).max(200),
});
export type RoleModel = z.infer<typeof RoleModelSchema>;

/**
 * The roles of `MODEL_ROLES`. Speech to text came later: clients that do not know it send
 * nothing, which means "not set".
 */
export const RolesSchema = z.object({
	fast: RoleModelSchema.nullable(),
	vision: RoleModelSchema.nullable(),
	smart: RoleModelSchema.nullable(),
	transcribe: RoleModelSchema.nullable().default(null),
	/** Text embeddings for family search; clients that do not know it send nothing. */
	embed: RoleModelSchema.nullable().default(null),
});
export type Roles = z.infer<typeof RolesSchema>;

export const LimitsSchema = z.object({
	/** USD per calendar month (family time zone), counting costs the provider reports. */
	monthlyCostLimit: z.number().positive().max(10_000).nullable(),
	/** Model calls per calendar month; works for every provider. */
	monthlyCallLimit: z.number().int().positive().max(1_000_000).nullable(),
});
export type Limits = z.infer<typeof LimitsSchema>;

/** What the AI may see, and how providers must treat it. */
export const PrivacySchema = z.object({
	/** Send photos and documents to the model. */
	sendFiles: z.boolean(),
	/** Send member names and "about" texts (otherwise the model cannot assign people). */
	sendPeople: z.boolean(),
	/** Send voice notes to the speech-to-text model (otherwise they are kept but not read). */
	sendVoice: z.boolean().default(true),
	/** OpenRouter: route only to providers that keep no data and do not train on it. */
	zeroRetention: z.boolean(),
});
export type Privacy = z.infer<typeof PrivacySchema>;

/** AI as a whole, and features turned off one by one (by the `feature` each call names). */
export const SwitchesSchema = z.object({
	enabled: z.boolean(),
	off: z.array(z.string().max(100)).max(200),
});
export type Switches = z.infer<typeof SwitchesSchema>;

export const AiSettingsSchema = z.object({
	providers: z.array(ProviderSchema),
	roles: RolesSchema,
	limits: LimitsSchema,
	privacy: PrivacySchema,
	switches: SwitchesSchema,
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

export const ModelListSchema = z.discriminatedUnion('ok', [
	z.object({ ok: z.literal(true), models: z.array(z.string()) }),
	z.object({
		ok: z.literal(false),
		reason: z.enum(['auth', 'unreachable', 'unexpected']),
		message: z.string(),
	}),
]);
export type ModelList = z.infer<typeof ModelListSchema>;

const UsageRowSchema = z.object({
	key: z.string(),
	calls: z.number().int(),
	errors: z.number().int(),
	inputTokens: z.number().int(),
	outputTokens: z.number().int(),
	cost: z.number(),
});

export const UsageSummarySchema = z.object({
	/** YYYY-MM in the family time zone. */
	month: z.string(),
	total: UsageRowSchema,
	byFeature: z.array(UsageRowSchema),
	byModel: z.array(UsageRowSchema),
	limits: LimitsSchema,
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

/** One model call as shown on the AI activity page. Never any prompt or output content. */
export const AiActivityEntrySchema = z.object({
	id: z.string(),
	/** Epoch ms when the call started. */
	at: z.number().int(),
	feature: z.string(),
	role: z.string(),
	/** Areas (extension ids) that contributed data; null when the call predates the record. */
	areas: z.array(z.string()).nullable(),
	provider: z.string(),
	model: z.string(),
	inputTokens: z.number().int().nullable(),
	outputTokens: z.number().int().nullable(),
	/** The part of the output spent on thinking, when the provider reported it. */
	reasoningTokens: z.number().int().nullable(),
	/** Why the model stopped (`stop`, `length` …); null when it did not answer. */
	finishReason: z.string().nullable(),
	/** USD, when known. */
	cost: z.number().nullable(),
	latencyMs: z.number().int(),
	/** The `LlmError` code of a failed or refused call; null when it worked. */
	errorCode: z.string().nullable(),
	/** Who the work was for (the sharer, say); resolved to a name by the server. */
	memberId: z.string().nullable(),
});
export type AiActivityEntry = z.infer<typeof AiActivityEntrySchema>;
