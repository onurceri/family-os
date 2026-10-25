import type {
	AiAreaAccess,
	Clock,
	DbExecutor,
	IdGenerator,
	LlmPolicy,
	Logger,
	ModelRole,
	OutputMode,
} from '@famos/sdk';
import { LlmError } from '@famos/sdk';
import { sql } from 'kysely';
import { type AiSettingsService, monthBounds } from '../settings.ts';
import { aiTables } from '../tables.ts';
import {
	type EmbeddingFactory,
	type ModelFactory,
	openAiCompatibleEmbedder,
	openAiCompatibleModel,
} from './clients.ts';

export interface AiSdkLlmDeps {
	db: DbExecutor;
	settings: AiSettingsService;
	clock: Clock;
	ids: IdGenerator;
	logger: Logger;
	timeZone(): Promise<string>;
	/**
	 * How far the AI may use an area (an extension id); core's cached setting. Calls
	 * whose `areas` include an area that is off, or local-only with a non-local provider, fail.
	 */
	areaAccess(extensionId: string): AiAreaAccess;
	model?: ModelFactory;
	embedder?: EmbeddingFactory;
	/** For speech-to-text calls; tests point it at a stand-in. */
	fetch?: typeof fetch;
}

/** The call's time limit, and the caller's signal when it has one. */
export function within(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const limit = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([limit, signal]) : limit;
}

export type LlmCalls = ReturnType<typeof createCalls>;

/**
 * What every kind of call shares: the clients, the limits and area rules, the role's model and
 * the usage record.
 */
export function createCalls(deps: AiSdkLlmDeps) {
	const factory = deps.model ?? openAiCompatibleModel;
	const embedder = deps.embedder ?? openAiCompatibleEmbedder;
	const logger = deps.logger.child({ component: 'llm' });

	async function checkLimits() {
		const limits = await deps.settings.limits();
		if (limits.monthlyCallLimit === null && limits.monthlyCostLimit === null) return;
		const { start, end } = monthBounds(await deps.timeZone(), deps.clock.now());
		const used = await aiTables(deps.db)
			.selectFrom('ai_usage')
			.select([
				(eb) => eb.fn.countAll<number>().as('calls'),
				sql<number>`coalesce(sum(cost_micros), 0)`.as('costMicros'),
			])
			.where('at', '>=', start)
			.where('at', '<', end)
			.executeTakeFirstOrThrow();
		if (limits.monthlyCallLimit !== null && Number(used.calls) >= limits.monthlyCallLimit) {
			throw new LlmError('limit_reached', 'The monthly limit of model calls is reached');
		}
		if (
			limits.monthlyCostLimit !== null &&
			Number(used.costMicros) / 1_000_000 >= limits.monthlyCostLimit
		) {
			throw new LlmError('limit_reached', 'The monthly AI budget is spent');
		}
	}

	/** The area rules for one call; the first area that is closed decides. */
	async function checkAreas(areas: readonly string[], baseUrl: string) {
		let local: boolean | undefined;
		for (const area of new Set(areas)) {
			const access = deps.areaAccess(area);
			if (access === 'off') throw new LlmError('disabled', `AI access to ${area} is off`);
			if (access === 'local') {
				local ??= await deps.settings.isLocal(baseUrl);
				if (!local)
					throw new LlmError(
						'local_required',
						`${area} may only use a local model, and the provider for this kind of work is not local`,
					);
			}
		}
	}

	/** Role → provider and model, or the error that tells the family what to set up. */
	async function target(roleName: ModelRole) {
		const privacy = await deps.settings.privacy();
		const role = (await deps.settings.roles())[roleName];
		if (!role) throw new LlmError('not_configured', `No model is set for the "${roleName}" role`);
		const resolved = await deps.settings.resolve(role.providerId).catch(() => null);
		const provider = resolved && { ...resolved, zeroRetention: privacy.zeroRetention };
		if (!provider)
			throw new LlmError(
				'not_configured',
				`The provider of the "${roleName}" role no longer exists`,
			);
		if (provider.kind === 'openrouter' && !provider.apiKey) {
			throw new LlmError(
				'auth',
				`${provider.name} has no readable API key; enter it again in AI settings`,
			);
		}
		return { privacy, role, provider };
	}

	/** Writes one `ai_usage` row for a call (also a failed or refused one). */
	function recorder(
		request: {
			role: ModelRole;
			feature: string;
			areas: readonly string[];
			memberId?: string | null | undefined;
			jobId?: string | null | undefined;
		},
		providerId: string,
		label: string,
		started: number,
	) {
		return async (fields: {
			input?: number | null;
			output?: number | null;
			reasoning?: number | null;
			finishReason?: string | null;
			cost?: number | null;
			errorCode?: string | null;
			outputMode?: OutputMode | null;
		}) => {
			await aiTables(deps.db)
				.insertInto('ai_usage')
				.values({
					id: deps.ids.next('ai_call'),
					at: started,
					role: request.role,
					provider_id: providerId,
					model: label,
					feature: request.feature,
					member_id: request.memberId ?? null,
					job_id: request.jobId ?? null,
					input_tokens: fields.input ?? null,
					output_tokens: fields.output ?? null,
					reasoning_tokens: fields.reasoning ?? null,
					finish_reason: fields.finishReason ?? null,
					cost_micros: fields.cost == null ? null : Math.round(fields.cost * 1_000_000),
					latency_ms: Math.max(0, deps.clock.now() - started),
					error_code: fields.errorCode ?? null,
					areas: JSON.stringify([...new Set(request.areas)]),
					output_mode: fields.outputMode ?? null,
				})
				.execute();
		};
	}

	/** What a failed call used, as the fields `record` takes. */
	const failureFields = (failure: LlmError) => ({
		errorCode: failure.code,
		input: failure.usage?.inputTokens ?? null,
		output: failure.usage?.outputTokens ?? null,
		reasoning: failure.usage?.reasoningTokens ?? null,
		finishReason: failure.usage?.finishReason ?? null,
		cost: failure.usage?.cost ?? null,
	});

	async function policy(feature: string, roleName: ModelRole): Promise<LlmPolicy> {
		const [{ sendFiles, sendPeople, sendVoice }, { enabled, off }, roles] = await Promise.all([
			deps.settings.privacy(),
			deps.settings.switches(),
			deps.settings.roles(),
		]);
		const role = roles[roleName];
		const resolved = role ? await deps.settings.resolve(role.providerId).catch(() => null) : null;
		return {
			enabled: enabled && !off.includes(feature),
			sendFiles,
			sendPeople,
			sendVoice,
			local: resolved ? await deps.settings.isLocal(resolved.baseUrl) : false,
			model: role && resolved ? `${resolved.id}:${role.model}` : null,
		};
	}

	return {
		factory,
		embedder,
		logger,
		checkLimits,
		checkAreas,
		target,
		recorder,
		failureFields,
		policy,
	};
}
