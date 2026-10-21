import {
	LimitsSchema,
	PrivacySchema,
	ProviderCreateSchema,
	ProviderEditSchema,
	type ProviderKind,
	ProviderRecordSchema,
	RolesSchema,
	SwitchesSchema,
} from '@famos/sdk';
import { z } from 'zod';

/**
 * AI settings shapes, shared by the adapter and the admin API. Provider kinds are presets over
 * one OpenAI-compatible client: OpenRouter, a local Ollama, or any compatible server. The shapes
 * a family chooses (roles, limits, privacy, switches) are defined in the SDK, where core's
 * actions take them; they are re-exported here for the adapter's callers.
 */
export {
	type Limits,
	LimitsSchema,
	PROVIDER_KINDS,
	type Privacy,
	PrivacySchema,
	type ProviderKind,
	ProviderKindSchema,
	type RoleModel,
	RoleModelSchema,
	type Roles,
	RolesSchema,
	type Switches,
	SwitchesSchema,
} from '@famos/sdk';

export const DEFAULT_BASE_URLS: Record<ProviderKind, string | null> = {
	openrouter: 'https://openrouter.ai/api/v1',
	ollama: 'http://localhost:11434/v1',
	'openai-compatible': null,
};

export const ProviderSchema = ProviderRecordSchema.extend({
	/** The address resolves only to local addresses: the family's own network. */
	local: z.boolean(),
});
export type Provider = z.infer<typeof ProviderSchema>;

/** The fixed id of the provider kept in line with `FAMOS_AI_*`. */
export const ENV_PROVIDER_ID = 'ai_provider_env';

export const ProviderInputSchema = ProviderCreateSchema.extend({
	apiKey: z.string().trim().min(1).max(500).optional(),
});
export type ProviderInput = z.input<typeof ProviderInputSchema>;

export const ProviderPatchSchema = ProviderEditSchema.extend({
	/** A new key, or null to remove the stored one. */
	apiKey: z.string().trim().min(1).max(500).nullable().optional(),
});
export type ProviderPatch = z.input<typeof ProviderPatchSchema>;

/** A key to store for a provider, or null to remove the stored one. */
export const ProviderKeySchema = z.object({
	apiKey: z.string().trim().min(1).max(500).nullable(),
});

export const AiSettingsSchema = z.object({
	providers: z.array(ProviderSchema),
	roles: RolesSchema,
	limits: LimitsSchema,
	privacy: PrivacySchema,
	switches: SwitchesSchema,
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

export const ModelListSchema = z.discriminatedUnion('ok', [
	z.object({
		ok: z.literal(true),
		models: z.array(z.string()),
		/**
		 * OpenRouter: the models at least one provider serves without keeping data. The others fail
		 * while "only providers that keep no data" is on. Absent when it is not known.
		 */
		zeroRetentionModels: z.array(z.string()).optional(),
	}),
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
