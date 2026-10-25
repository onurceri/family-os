import { type Actor, type AnyActionDefinition, type DbExecutor, FamosError } from '@famos/sdk';
import { PERSON_ONLY_CAPABILITIES } from '../access.ts';
import {
	admission,
	type DecideEnv,
	type DecideFacts,
	type Decision,
	decide,
	needsOwner,
	refusalError,
} from '../decide.ts';
import { familyReader } from '../family.ts';
import { ownerOf } from '../features.ts';
import type { CoreTables } from '../tables.ts';
import { parseOrThrow } from './shared.ts';
import type { ActionRunnerDeps } from './types.ts';

/**
 * Who may run an action at all, and the decision (apply, draft or refuse) for one input: the
 * capabilities, the extension's manifest, and the reads an action's checks see.
 */
export function createAdmission(deps: ActionRunnerDeps) {
	const { registry, access } = deps;
	const can = (actor: Actor, capability: string) => access.can(actor, capability);
	// What only a person may do: an admin's critical acts, and the acts no app holds (deciding
	// suggestions, a person's own keys, PIN sign-in). The AI never runs nor proposes either.
	const criticalCapabilities = new Set([
		...registry.capabilities.filter((c) => c.critical === true).map((c) => c.id),
		...PERSON_ONLY_CAPABILITIES,
	]);

	const env: DecideEnv = {
		access,
		critical: criticalCapabilities,
		...(deps.aiAreaAccess && { aiArea: deps.aiAreaAccess }),
	};

	/** Who may invoke at all (see `admission`); approval is decided separately. */
	function authorize(def: AnyActionDefinition, actor: Actor): void {
		const refusal = admission(def, actor, env);
		if (refusal) throw refusalError(refusal);
	}

	/**
	 * The decision for one parsed input: the facts it needs are read here (the owner only when the
	 * decision turns on it, since that costs a query).
	 */
	async function decideInput(
		def: AnyActionDefinition,
		actor: Actor,
		input: unknown,
		settled: string | null,
		db: DbExecutor = deps.db,
	): Promise<Decision> {
		const facts: DecideFacts = { input, settled };
		const policy = def.approval;
		if (typeof policy === 'object' && policy.owner && needsOwner(def, actor, env, facts))
			facts.owner = await policy.owner(readContext(def, db), input);
		return decide(def, actor, env, facts);
	}

	/** Why an AI's proposal would change nothing (the action's `refuseProposal`), or null. */
	async function settledReason(def: AnyActionDefinition, actor: Actor, input: unknown) {
		if (actor.kind !== 'ai' || !def.refuseProposal) return null;
		return def.refuseProposal(readContext(def), input);
	}

	function decisionsFor(actor: Actor): Record<string, Decision> {
		const out: Record<string, Decision> = {};
		for (const def of registry.actions.values()) {
			if (def.readOnly || !deps.features.isOn(ownerOf(def.id))) continue;
			out[def.id] = decide(def, actor, env);
		}
		return out;
	}

	async function check(actionId: string, rawInput: unknown, actor: Actor): Promise<Decision> {
		const def = getAction(actionId);
		const before = decide(def, actor, env);
		if (before.outcome === 'refuse' && !before.depends) return before;
		const parsed = parseOrThrow(def.input, rawInput, `input for ${actionId}`);
		const input = def.resolveNames ? await def.resolveNames(readContext(def), parsed) : parsed;
		return decideInput(def, actor, input, await settledReason(def, actor, input));
	}
	const coreDb = () => deps.db.withTables<CoreTables>();

	const getAction = (actionId: string) => {
		const def = registry.actions.get(actionId);
		if (!def) throw new FamosError('not_found', `Unknown action "${actionId}"`);
		if (!deps.features.isOn(ownerOf(actionId)))
			throw new FamosError('feature_off', `${ownerOf(actionId)} is turned off`);
		return def;
	};

	const manifests = new Map(registry.extensions.map((e) => [e.id, e.manifest]));
	const contextActions = new Set(registry.extensions.flatMap((e) => [e.ai?.context ?? []].flat()));

	/**
	 * Whether an extension may run an action: its own, one its manifest's `calls` lists, or, as an
	 * AI actor, one the AI is offered (the Inbox and the assistant act for the AI). The host and
	 * core may run any. What the actor may do is checked separately, by `authorize`.
	 */
	function assertCallable(caller: string, def: AnyActionDefinition, actor: Actor): void {
		if (caller === 'core' || ownerOf(def.id) === caller) return;
		if (manifests.get(caller)?.calls.includes(def.id)) return;
		if (actor.kind === 'ai' && (def.ai !== undefined || contextActions.has(def.id))) return;
		throw new FamosError(
			'forbidden',
			`Extension "${caller}" may not run ${def.id}: list it in famos.calls of its package.json`,
		);
	}

	/** The extension that owns each typed-id prefix of a record, as extensions declare them. */
	const recordOwners = new Map(
		registry.extensions.flatMap((e) =>
			(e.recordIds ?? []).map((prefix) => [prefix, e.id] as const),
		),
	);
	const TYPED_ID = /^(.+)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

	/**
	 * Whether an action run inside another is covered by the outer action's own decision: it is a
	 * service action marked `nested.governedBy: 'owner'`, the caller is the extension that owns
	 * the record it is about (by the id's prefix, as that extension declared it), and the caller
	 * is not the service itself. Anything else is decided on its own.
	 */
	async function governedByOwner(
		def: AnyActionDefinition,
		caller: string,
		input: unknown,
		db: DbExecutor,
	): Promise<boolean> {
		if (def.nested?.governedBy !== 'owner' || caller === ownerOf(def.id)) return false;
		const record = await def.nested.record(readContext(def, db), input);
		const prefix = record === null ? undefined : TYPED_ID.exec(record)?.[1];
		return prefix !== undefined && recordOwners.get(prefix) === caller;
	}

	/** What an action's checks read (names, titles, duplicates) see: its extension's tables. */
	const readContext = (def: AnyActionDefinition, db: DbExecutor = deps.db) => ({
		db: deps.views.db(ownerOf(def.id), db),
		family: familyReader(db),
		translate: deps.translate,
		vocabulary: deps.vocabulary,
		now: deps.clock.now(),
	});

	return {
		can,
		env,
		authorize,
		decideInput,
		settledReason,
		decisionsFor,
		check,
		coreDb,
		getAction,
		assertCallable,
		governedByOwner,
		readContext,
	};
}

export type Admission = ReturnType<typeof createAdmission>;
