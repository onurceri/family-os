import { isIP } from 'node:net';
import type { DbExecutor } from '@famos/sdk';
import {
	type AiSettingsWriter,
	type Clock,
	FamosError,
	type IdGenerator,
	MODEL_ROLES,
	type ProviderEdited,
	type ProviderRecord,
} from '@famos/sdk';
import { Temporal } from '@famos/time';
import { sql } from 'kysely';
import { defaultResolver, isLocalAddress, type Resolver } from '../http-guard/index.ts';
import type { SecretBox } from './crypto.ts';
import {
	type AiActivityEntry,
	type AiSettings,
	DEFAULT_BASE_URLS,
	ENV_PROVIDER_ID,
	type Limits,
	LimitsSchema,
	type ModelList,
	type Privacy,
	PrivacySchema,
	type Provider,
	type ProviderInput,
	ProviderInputSchema,
	type ProviderKind,
	type ProviderPatch,
	ProviderPatchSchema,
	type Roles,
	RolesSchema,
	type Switches,
	SwitchesSchema,
	type UsageSummary,
} from './schemas.ts';
import { type AiTables, aiTables } from './tables.ts';

const NO_ROLES: Roles = Object.fromEntries(MODEL_ROLES.map((r) => [r, null])) as Roles;
const NO_LIMITS: Limits = { monthlyCostLimit: null, monthlyCallLimit: null };
/**
 * Files and names are on because reading needs them. Limiting OpenRouter to providers that keep
 * no data is the family's choice, off unless they turn it on: it makes many models, most free
 * ones among them, unavailable, and the family decides which model to use.
 */
const DEFAULT_PRIVACY: Privacy = {
	sendFiles: true,
	sendPeople: true,
	sendVoice: true,
	zeroRetention: false,
};
const DEFAULT_SWITCHES: Switches = { enabled: true, off: [] };

export interface AiSettingsDeps {
	db: DbExecutor;
	box: SecretBox;
	clock: Clock;
	ids: IdGenerator;
	/** The family time zone, for monthly limits and usage. */
	timeZone(): Promise<string>;
	fetch?: typeof fetch;
	/** Resolves a provider's host to decide whether it is local; tests inject their own. */
	resolve?: Resolver;
}

/** Everything the model client needs to call one provider. */
export interface ResolvedProvider {
	id: string;
	name: string;
	kind: ProviderKind;
	baseUrl: string;
	apiKey: string | null;
	/** OpenRouter: ask for zero-data-retention providers only (privacy setting). */
	zeroRetention?: boolean;
}

/** The calendar month containing `now` in `timeZone`, as epoch ms bounds. */
export function monthBounds(
	timeZone: string,
	now: number,
): { month: string; start: number; end: number } {
	const today = Temporal.Instant.fromEpochMilliseconds(now)
		.toZonedDateTimeISO(timeZone)
		.toPlainDate();
	const first = today.with({ day: 1 });
	const at = (d: Temporal.PlainDate) => d.toZonedDateTime(timeZone).epochMilliseconds;
	return {
		month: first.toString().slice(0, 7),
		start: at(first),
		end: at(first.add({ months: 1 })),
	};
}

function parseAreas(raw: string | null): string[] | null {
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : null;
	} catch {
		return null;
	}
}

/**
 * The models OpenRouter can serve from at least one provider that keeps no data, so the model
 * picker can mark the others. Only a hint: when the list cannot be read, nothing is marked.
 */
async function openRouterZeroRetentionModels(
	baseUrl: string,
	headers: Record<string, string>,
	doFetch: typeof fetch = fetch,
): Promise<string[] | null> {
	try {
		const response = await doFetch(`${baseUrl}/endpoints/zdr`, {
			headers,
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) return null;
		const body = (await response.json()) as { data?: { model_id?: unknown }[] };
		if (!Array.isArray(body.data)) return null;
		const ids = body.data.map((e) => e.model_id).filter((m): m is string => typeof m === 'string');
		return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
	} catch {
		return null;
	}
}

export type AiSettingsService = ReturnType<typeof createAiSettings>;

/**
 * AI configuration stored in the database: providers with sealed keys, the role →
 * model mapping and monthly limits. Writes are admin operations outside the action runner
 * because they handle credentials (like passwords and device trust).
 */
export function createAiSettings(deps: AiSettingsDeps) {
	const db = () => aiTables(deps.db);
	const doFetch = deps.fetch ?? fetch;

	/**
	 * Whether an address resolves only to local addresses (loopback, home network; the same test
	 * as the guarded HTTP port). Decided by the address, not the provider kind; looked up when
	 * asked and cached for a minute. A name that does not resolve is not local.
	 */
	const localCache = new Map<string, { local: boolean; until: number }>();
	async function isLocal(baseUrl: string): Promise<boolean> {
		let host: string;
		try {
			host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
		} catch {
			return false;
		}
		const now = deps.clock.now();
		const cached = localCache.get(host);
		if (cached && cached.until > now) return cached.local;
		let local: boolean;
		try {
			const addresses = isIP(host) ? [host] : await (deps.resolve ?? defaultResolver)(host);
			local = addresses.length > 0 && addresses.every(isLocalAddress);
		} catch {
			local = false;
		}
		localCache.set(host, { local, until: now + 60_000 });
		return local;
	}

	const toRecord = (row: AiTables['ai_providers']): ProviderRecord => ({
		id: row.id,
		name: row.name,
		kind: row.kind,
		baseUrl: row.base_url,
		hasKey: row.api_key !== null,
		keyReadable: row.api_key === null || deps.box.open(row.api_key) !== null,
		managed: row.id === ENV_PROVIDER_ID,
	});
	const toView = async (row: AiTables['ai_providers']): Promise<Provider> => ({
		...toRecord(row),
		local: await isLocal(row.base_url),
	});

	async function readSetting<T>(
		key: 'roles' | 'limits' | 'privacy' | 'switches',
		fallback: T,
		parse: (v: unknown) => T,
	): Promise<T> {
		const row = await db()
			.selectFrom('ai_settings')
			.select('value')
			.where('key', '=', key)
			.executeTakeFirst();
		if (!row) return fallback;
		try {
			return parse(JSON.parse(row.value));
		} catch {
			return fallback;
		}
	}

	async function writeSetting(key: 'roles' | 'limits' | 'privacy' | 'switches', value: unknown) {
		const now = deps.clock.now();
		const json = JSON.stringify(value);
		await db()
			.insertInto('ai_settings')
			.values({ key, value: json, updated_at: now })
			.onConflict((oc) => oc.column('key').doUpdateSet({ value: json, updated_at: now }))
			.execute();
	}

	const roles = () =>
		readSetting('roles', NO_ROLES, (v) => RolesSchema.parse({ ...NO_ROLES, ...(v as object) }));
	const limits = () => readSetting('limits', NO_LIMITS, (v) => LimitsSchema.parse(v));
	const privacy = () =>
		readSetting('privacy', DEFAULT_PRIVACY, (v) =>
			PrivacySchema.parse({ ...DEFAULT_PRIVACY, ...(v as object) }),
		);
	const switches = () => readSetting('switches', DEFAULT_SWITCHES, (v) => SwitchesSchema.parse(v));

	async function providerRow(id: string) {
		const row = await db()
			.selectFrom('ai_providers')
			.selectAll()
			.where('id', '=', id)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', 'Provider not found');
		return row;
	}

	async function resolve(id: string): Promise<ResolvedProvider> {
		const row = await providerRow(id);
		return {
			id: row.id,
			name: row.name,
			kind: row.kind,
			baseUrl: row.base_url,
			apiKey: row.api_key ? deps.box.open(row.api_key) : null,
		};
	}

	function refuseManaged(id: string) {
		if (id === ENV_PROVIDER_ID)
			throw new FamosError(
				'bad_request',
				'This provider is set by the server configuration (FAMOS_AI_*); change it there',
				{ reason: 'managed' },
			);
	}

	async function insertProvider(input: ProviderInput): Promise<AiTables['ai_providers']> {
		const v = ProviderInputSchema.parse(input);
		const baseUrl = v.baseUrl ?? DEFAULT_BASE_URLS[v.kind];
		if (!baseUrl) throw new FamosError('bad_request', 'This provider needs an address');
		const now = deps.clock.now();
		const row = {
			id: deps.ids.next('ai_provider'),
			name: v.name,
			kind: v.kind,
			base_url: baseUrl,
			api_key: v.apiKey ? deps.box.seal(v.apiKey) : null,
			created_at: now,
			updated_at: now,
		};
		await db().insertInto('ai_providers').values(row).execute();
		return row;
	}

	/**
	 * Applies a change to a provider's name, address or key. A stored key is only ever sent to
	 * the address it was entered for: pointing the provider somewhere else drops it, unless a new
	 * key comes with the change.
	 */
	async function patchProvider(
		id: string,
		patch: ProviderPatch,
	): Promise<{ row: AiTables['ai_providers']; keyDropped: boolean }> {
		refuseManaged(id);
		const v = ProviderPatchSchema.parse(patch);
		const current = await providerRow(id);
		const moved = v.baseUrl !== undefined && v.baseUrl !== current.base_url;
		if (moved && v.apiKey === undefined) v.apiKey = null;
		await db()
			.updateTable('ai_providers')
			.set({
				...(v.name !== undefined && { name: v.name }),
				...(v.baseUrl !== undefined && { base_url: v.baseUrl }),
				...(v.apiKey !== undefined && {
					api_key: v.apiKey === null ? null : deps.box.seal(v.apiKey),
				}),
				updated_at: deps.clock.now(),
			})
			.where('id', '=', id)
			.execute();
		return {
			row: await providerRow(id),
			keyDropped: moved && current.api_key !== null && v.apiKey === null,
		};
	}

	async function deleteProvider(id: string): Promise<void> {
		refuseManaged(id);
		await providerRow(id);
		await db().deleteFrom('ai_providers').where('id', '=', id).execute();
		const current = await roles();
		const next = Object.fromEntries(
			Object.entries(current).map(([role, value]) => [
				role,
				value?.providerId === id ? null : value,
			]),
		);
		await writeSetting('roles', next);
	}

	async function setRoles(input: Roles): Promise<Roles> {
		const next = RolesSchema.parse(input);
		const ids = new Set(
			(await db().selectFrom('ai_providers').select('id').execute()).map((r) => r.id),
		);
		for (const value of Object.values(next)) {
			if (value && !ids.has(value.providerId))
				throw new FamosError('bad_request', `Unknown provider: ${value.providerId}`);
		}
		await writeSetting('roles', next);
		return next;
	}

	async function setSwitches(input: Switches): Promise<Switches> {
		const next = SwitchesSchema.parse(input);
		await writeSetting('switches', { ...next, off: [...new Set(next.off)].sort() });
		return next;
	}

	async function setPrivacy(input: Privacy): Promise<Privacy> {
		const next = PrivacySchema.parse(input);
		await writeSetting('privacy', next);
		return next;
	}

	async function setLimits(input: Limits): Promise<Limits> {
		const next = LimitsSchema.parse(input);
		await writeSetting('limits', next);
		return next;
	}

	/** The writes an action makes, with nothing about a key in or out of them. */
	const writer: AiSettingsWriter = {
		async createProvider(input) {
			return toRecord(await insertProvider(input));
		},
		async updateProvider(id, patch): Promise<ProviderEdited> {
			const { row, keyDropped } = await patchProvider(id, patch);
			return { provider: toRecord(row), keyDropped };
		},
		deleteProvider,
		setRoles,
		setLimits,
		setPrivacy,
		setSwitches,
	};

	return {
		roles,
		limits,
		privacy,
		switches,
		resolve,
		isLocal,

		async get(): Promise<AiSettings> {
			const rows = await db()
				.selectFrom('ai_providers')
				.selectAll()
				.orderBy('created_at')
				.execute();
			return {
				providers: await Promise.all(rows.map(toView)),
				roles: await roles(),
				limits: await limits(),
				privacy: await privacy(),
				switches: await switches(),
			};
		},

		async createProvider(input: ProviderInput): Promise<Provider> {
			return toView(await insertProvider(input));
		},

		async updateProvider(id: string, patch: ProviderPatch): Promise<Provider> {
			return toView((await patchProvider(id, patch)).row);
		},

		/** Stores a provider's key, or removes it with null: the one write that stays a route. */
		async setApiKey(id: string, apiKey: string | null): Promise<Provider> {
			return toView((await patchProvider(id, { apiKey })).row);
		},

		deleteProvider,
		setRoles,
		setSwitches,
		setPrivacy,
		setLimits,

		/** The same service on another connection: a unit of work's own (see `AiSettingsAdmin`). */
		in: (executor: DbExecutor): AiSettingsWriter =>
			createAiSettings({ ...deps, db: executor }).writer,
		writer,

		/**
		 * Lists the provider's models (`GET /models`). This is the connection test: it checks the
		 * address and key without running a model, so it is safe inside an admin request.
		 */
		async listModels(id: string): Promise<ModelList> {
			const provider = await resolve(id);
			const headers: Record<string, string> = provider.apiKey
				? { authorization: `Bearer ${provider.apiKey}` }
				: {};
			const refused = (status: number): ModelList => ({
				ok: false,
				reason: 'auth',
				message: `The provider refused the key (HTTP ${status})`,
			});
			try {
				// OpenRouter lists models without a key, so check the key itself first.
				if (provider.kind === 'openrouter') {
					const key = await doFetch(`${provider.baseUrl}/key`, {
						headers,
						signal: AbortSignal.timeout(10_000),
					});
					if (key.status === 401 || key.status === 403) return refused(key.status);
				}
				const response = await doFetch(`${provider.baseUrl}/models`, {
					headers,
					signal: AbortSignal.timeout(10_000),
				});
				if (response.status === 401 || response.status === 403) return refused(response.status);
				if (!response.ok)
					return { ok: false, reason: 'unexpected', message: `HTTP ${response.status}` };
				const body = (await response.json()) as {
					data?: { id?: unknown }[];
					models?: { name?: unknown }[];
				};
				const models = (body.data ?? [])
					.map((m) => m.id)
					.filter((m): m is string => typeof m === 'string')
					.sort((a, b) => a.localeCompare(b));
				if (provider.kind !== 'openrouter') return { ok: true, models };
				const zeroRetentionModels = await openRouterZeroRetentionModels(
					provider.baseUrl,
					headers,
					doFetch,
				);
				return { ok: true, models, ...(zeroRetentionModels && { zeroRetentionModels }) };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, reason: 'unreachable', message };
			}
		},

		async usage(now = deps.clock.now()): Promise<UsageSummary> {
			const { month, start, end } = monthBounds(await deps.timeZone(), now);
			const base = () =>
				db()
					.selectFrom('ai_usage')
					.where('at', '>=', start)
					.where('at', '<', end)
					.select([
						(eb) => eb.fn.countAll<number>().as('calls'),
						sql<number>`sum(case when error_code is null then 0 else 1 end)`.as('errors'),
						sql<number>`coalesce(sum(input_tokens), 0)`.as('inputTokens'),
						sql<number>`coalesce(sum(output_tokens), 0)`.as('outputTokens'),
						sql<number>`coalesce(sum(cost_micros), 0)`.as('costMicros'),
					]);
			type Agg = {
				calls: number;
				errors: number | null;
				inputTokens: number;
				outputTokens: number;
				costMicros: number;
			};
			const row = (key: string, a: Agg) => ({
				key,
				calls: Number(a.calls),
				errors: Number(a.errors ?? 0),
				inputTokens: Number(a.inputTokens),
				outputTokens: Number(a.outputTokens),
				cost: Number(a.costMicros) / 1_000_000,
			});
			const total = (await base().executeTakeFirstOrThrow()) as Agg;
			const byFeature = (await base()
				.select('feature')
				.groupBy('feature')
				.orderBy('feature')
				.execute()) as (Agg & { feature: string })[];
			const byModel = (await base()
				.select('model')
				.groupBy('model')
				.orderBy('model')
				.execute()) as (Agg & { model: string })[];
			return {
				month,
				total: row('total', total),
				byFeature: byFeature.map((r) => row(r.feature, r)),
				byModel: byModel.map((r) => row(r.model, r)),
				limits: await limits(),
			};
		},

		/**
		 * The newest model calls first, for the AI activity page. `before` is the
		 * `next` cursor of the previous page. Only metadata is stored, so only metadata is shown.
		 */
		async activity(
			options: { limit?: number; before?: string } = {},
		): Promise<{ entries: AiActivityEntry[]; next: string | null }> {
			const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
			let query = db().selectFrom('ai_usage').selectAll();
			const cursor = options.before ? /^(\d+):(.+)$/.exec(options.before) : null;
			if (cursor) {
				const at = Number(cursor[1]);
				const id = cursor[2] as string;
				query = query.where((eb) =>
					eb.or([eb('at', '<', at), eb.and([eb('at', '=', at), eb('id', '<', id)])]),
				);
			}
			const rows = await query
				.orderBy('at', 'desc')
				.orderBy('id', 'desc')
				.limit(limit + 1)
				.execute();
			const page = rows.slice(0, limit);
			const last = page.at(-1);
			return {
				entries: page.map((r) => {
					// `model` is stored as "provider name / model".
					const split = r.model.indexOf(' / ');
					return {
						id: r.id,
						at: r.at,
						feature: r.feature,
						role: r.role,
						areas: parseAreas(r.areas),
						provider: split < 0 ? '' : r.model.slice(0, split),
						model: split < 0 ? r.model : r.model.slice(split + 3),
						inputTokens: r.input_tokens,
						outputTokens: r.output_tokens,
						reasoningTokens: r.reasoning_tokens,
						finishReason: r.finish_reason,
						cost: r.cost_micros === null ? null : r.cost_micros / 1_000_000,
						latencyMs: r.latency_ms,
						errorCode: r.error_code,
						memberId: r.member_id,
					};
				}),
				next: rows.length > limit && last ? `${last.at}:${last.id}` : null,
			};
		},

		/**
		 * Keeps the provider set by the server configuration (`FAMOS_AI_*`) in line with it, on
		 * every start: created, updated or, when the variables are gone, removed. It has a fixed id
		 * and cannot be edited in the app, so the environment and the screen never disagree.
		 * Roles that are unset or already use it take the configured models; roles the family
		 * pointed at another provider stay theirs. Providers added in the app are never touched.
		 */
		async syncFromEnvironment(
			input:
				| (ProviderInput & { models?: Partial<Record<(typeof MODEL_ROLES)[number], string>> })
				| null,
		): Promise<'created' | 'updated' | 'removed' | 'unchanged'> {
			const existing = await db()
				.selectFrom('ai_providers')
				.selectAll()
				.where('id', '=', ENV_PROVIDER_ID)
				.executeTakeFirst();
			const current = await roles();
			if (!input) {
				if (!existing) return 'unchanged';
				await db().deleteFrom('ai_providers').where('id', '=', ENV_PROVIDER_ID).execute();
				await writeSetting(
					'roles',
					Object.fromEntries(
						Object.entries(current).map(([role, value]) => [
							role,
							value?.providerId === ENV_PROVIDER_ID ? null : value,
						]),
					),
				);
				return 'removed';
			}
			const { models, ...providerInput } = input;
			const v = ProviderInputSchema.parse(providerInput);
			const baseUrl = v.baseUrl ?? DEFAULT_BASE_URLS[v.kind];
			if (!baseUrl) throw new FamosError('bad_request', 'This provider needs an address');
			const now = deps.clock.now();
			const values = {
				name: v.name,
				kind: v.kind,
				base_url: baseUrl,
				api_key: v.apiKey ? deps.box.seal(v.apiKey) : null,
				updated_at: now,
			};
			if (existing)
				await db()
					.updateTable('ai_providers')
					.set(values)
					.where('id', '=', ENV_PROVIDER_ID)
					.execute();
			else
				await db()
					.insertInto('ai_providers')
					.values({ id: ENV_PROVIDER_ID, created_at: now, ...values })
					.execute();
			const next = { ...current };
			for (const role of MODEL_ROLES) {
				const model = models?.[role];
				const mine = !next[role] || next[role]?.providerId === ENV_PROVIDER_ID;
				if (model && mine) next[role] = { providerId: ENV_PROVIDER_ID, model };
			}
			await writeSetting('roles', next);
			return existing ? 'updated' : 'created';
		},
	};
}
