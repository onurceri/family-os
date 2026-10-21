import { z } from 'zod';
import type { DbExecutor } from './ports.ts';

/**
 * What a family chooses about its AI: providers, which model does which job, limits, what the
 * AI may see and what is switched off. The shapes live here because core's actions take them as
 * input and the model adapter stores them; neither imports the other.
 */
export const PROVIDER_KINDS = ['openrouter', 'ollama', 'openai-compatible'] as const;
export const ProviderKindSchema = z.enum(PROVIDER_KINDS);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const BaseUrlSchema = z
	.url({ protocol: /^https?$/ })
	.max(300)
	.transform((u) => u.replace(/\/+$/, ''));

/** A provider as the settings screen lists it, without the address check and without the key. */
export const ProviderRecordSchema = z.object({
	id: z.string(),
	name: z.string(),
	kind: ProviderKindSchema,
	baseUrl: z.string(),
	/** A key is stored (never returned). */
	hasKey: z.boolean(),
	/** False when the stored key cannot be decrypted (FAMOS_SECRET changed): enter it again. */
	keyReadable: z.boolean(),
	/** Set by the server configuration (`FAMOS_AI_*`): read-only here, changed on restart. */
	managed: z.boolean(),
});
export type ProviderRecord = z.infer<typeof ProviderRecordSchema>;

/** A new provider. The key is set apart, in its own route, since it is a secret. */
export const ProviderCreateSchema = z.object({
	name: z.string().trim().min(1).max(60),
	kind: ProviderKindSchema,
	/** Defaults to the kind's usual address. */
	baseUrl: BaseUrlSchema.optional(),
});
export type ProviderCreate = z.input<typeof ProviderCreateSchema>;

export const ProviderEditSchema = z.object({
	name: z.string().trim().min(1).max(60).optional(),
	baseUrl: BaseUrlSchema.optional(),
});
export type ProviderEdit = z.input<typeof ProviderEditSchema>;

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

/** What changing a provider did to the key it held. */
export interface ProviderEdited {
	provider: ProviderRecord;
	/** The address moved, so the stored key was dropped: a key is only sent where it was entered for. */
	keyDropped: boolean;
}

/**
 * The AI settings writes, on the unit of work's own connection. The model adapter keeps the
 * settings on its own handle, and a second handle waits for the first one forever inside a
 * transaction, so an action reaches them only through `in(uow.db)`. No method takes or returns a
 * key: setting one is a route, outside the runner.
 */
export interface AiSettingsWriter {
	createProvider(input: ProviderCreate): Promise<ProviderRecord>;
	updateProvider(id: string, patch: ProviderEdit): Promise<ProviderEdited>;
	/** Removes a provider; roles that used it become unset. */
	deleteProvider(id: string): Promise<void>;
	setRoles(input: Roles): Promise<Roles>;
	setLimits(input: Limits): Promise<Limits>;
	setPrivacy(input: Privacy): Promise<Privacy>;
	setSwitches(input: Switches): Promise<Switches>;
}

export interface AiSettingsAdmin {
	in(db: DbExecutor): AiSettingsWriter;
}
