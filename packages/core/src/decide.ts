import { type AccessControl, type Actor, type AnyActionDefinition, FamosError } from '@famos/sdk';
import { z } from 'zod';
import { ANONYMOUS } from './access.ts';
import { mayUseAsAi } from './ai-tools.ts';
import { CORE_CAPABILITIES } from './core-capabilities.ts';
import { ownerOf } from './features.ts';

/**
 * Why an action or route was refused, in the `details.reason` of a `forbidden` error, so an app
 * can say it in the reader's words: the role lacks a capability (`capability`), the change would
 * need approval and the role may not suggest it either (`approval`), a display only shows
 * (`display`), the request is not signed in (`sign_in`), the AI may not do it for this person
 * (`ai`), it is a person's own act that the AI never runs (`critical`), or the AI is kept out of
 * that part of the app (`area`).
 */
export const ACCESS_REFUSALS = [
	'capability',
	'approval',
	'display',
	'sign_in',
	'ai',
	'critical',
	'area',
] as const;
export type AccessRefusal = (typeof ACCESS_REFUSALS)[number];

/** Why a `forbidden` error refused and what would allow it, when it says. */
export function accessRefusalOf(
	error: FamosError,
): { reason: AccessRefusal; capability?: string } | null {
	const details = error.details as Record<string, unknown> | null | undefined;
	const reason = details?.reason;
	if (error.code !== 'forbidden' || !isAccessRefusal(reason)) return null;
	const capability = details?.capability;
	return { reason, ...(typeof capability === 'string' && { capability }) };
}

const isAccessRefusal = (reason: unknown): reason is AccessRefusal =>
	(ACCESS_REFUSALS as readonly unknown[]).includes(reason);

/**
 * What would happen if an actor ran an action: it is applied, it becomes a draft someone
 * approves, or it is refused. `reason` says why: for `apply`, the exception that let it through
 * (`owner`: their own thing; `except`: the policy's own exception); for `draft`, that the role
 * needs approval (`approval`) or that the AI's changes are always drafts (`ai`); for `refuse`, an
 * access refusal or, for an AI's proposal, that what it asks for is already so (`settled`).
 * `capability` is what would let the actor do it directly (or at all). `depends` marks an answer
 * that may change with the input (an owner, an exception, a policy function): it is the answer
 * when no exception applies.
 */
export const DecisionSchema = z.object({
	outcome: z.enum(['apply', 'draft', 'refuse']),
	reason: z.enum(['owner', 'except', 'settled', ...ACCESS_REFUSALS]).optional(),
	capability: z.string().optional(),
	depends: z.literal(true).optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;

/** What the decision needs from the kernel besides the action and the actor. */
export interface DecideEnv {
	access: AccessControl;
	/** Capabilities only a person may use (the AI never runs nor proposes their actions). */
	critical: ReadonlySet<string>;
	/** The AI's access to an extension's area (`off` closes it). */
	aiArea?: (extensionId: string) => 'off' | 'local' | 'any';
}

/** The facts about one call; without them the decision is the one for any input. */
export interface DecideFacts {
	input: unknown;
	/**
	 * The member whose own thing the input changes (the policy's `owner`), or null for no one.
	 * Left out until the decision asks for it (`needsOwner`): reading it costs a query.
	 */
	owner?: string | null;
	/** Why an AI's proposal changes nothing (the action's `refuseProposal`), or null. */
	settled?: string | null;
}

/** A refusal and what would allow it, before any message is written. */
type Refusal = { reason: AccessRefusal; capability?: string };

/**
 * Whether the actor may invoke the action at all, whatever the input and approval: `requires`
 * for people, the policy for the AI, displays and unauthenticated callers. Null when it may.
 */
export function admission(def: AnyActionDefinition, actor: Actor, env: DecideEnv): Refusal | null {
	const can = (capability: string) => env.access.can(actor, capability);
	// A display only looks: no action, not even a read-only one.
	if (actor.kind === 'display') return { reason: 'display' };
	if (actor.kind === 'member' && def.requires && !can(def.requires)) {
		return { reason: 'capability', capability: def.requires };
	}
	// The AI is checked like a member: it may read what its capabilities and the area switches
	// allow, so a locked area refuses it. Its data-changing proposals are not judged here (they
	// only become drafts, which a person approves; `requires` is checked against the approver).
	if (actor.kind === 'ai' && def.readOnly && def.requires && !can(def.requires)) {
		return { reason: 'capability', capability: def.requires };
	}
	// Acting for a member, it never exceeds them: a change must be one that member could make or
	// propose, a read one their capabilities allow.
	if (actor.kind === 'ai' && !mayUseAsAi(env.access, def, actor)) {
		return { reason: 'ai', ...(def.requires && { capability: def.requires }) };
	}
	// What only an admin may do (a critical capability: installing extensions, managing members)
	// is a person's own act: the AI never runs it and never proposes it, not even for an admin, so
	// no draft of it can reach an approver.
	if (actor.kind === 'ai' && def.requires && env.critical.has(def.requires)) {
		return { reason: 'critical', capability: def.requires };
	}
	// A locked area is closed to the AI whatever its actions declare: no read (even without
	// `requires`) and no draft. Protection does not depend on each extension's discipline.
	if (actor.kind === 'ai' && env.aiArea?.(ownerOf(def.id)) === 'off') {
		return { reason: 'area' };
	}
	// A digest gathers a topic's facts for a model to read: a local-only area gives them only to a
	// model that runs on the family's own network.
	if (
		actor.kind === 'ai' &&
		def.ai?.digest !== undefined &&
		actor.local !== true &&
		env.aiArea?.(ownerOf(def.id)) === 'local'
	) {
		return { reason: 'area' };
	}
	// An unauthenticated caller of a public route holds no capability: it can never run an action
	// that requires one (or change data at all). Routes that need bookkeeping use their own named
	// system actor.
	if (actor.kind === 'system' && actor.source === ANONYMOUS && (def.requires || !def.readOnly)) {
		return { reason: 'sign_in' };
	}
	return null;
}

/**
 * Whether a person's own thing may be changed directly by them. Owning a thing never lets
 * anyone do more than they could already do another way: a role that may propose the change, or
 * one that holds the action's own `requires` (it made the thing directly, so it may take its own
 * mistake back). The AI is never asked: its changes are always drafts.
 */
function ownerMayAct(def: AnyActionDefinition, actor: Actor, env: DecideEnv): boolean {
	if (actor.kind !== 'member') return false;
	if (def.requires !== undefined && env.access.can(actor, def.requires)) return true;
	return env.access.can(actor, CORE_CAPABILITIES.draftsPropose.id);
}

type Approval =
	| { needed: false; reason?: 'owner' | 'except' }
	| { needed: true; reason: 'approval' | 'ai'; capability?: string }
	/** The answer turns on what the decision has not been given: the input or its owner. */
	| { needed: 'unknown'; missing: 'input' | 'owner'; capability: string | undefined };

function approval(
	def: AnyActionDefinition,
	actor: Actor,
	env: DecideEnv,
	facts: DecideFacts | undefined,
): Approval {
	if (def.readOnly) return { needed: false };
	// AI is checked first: its changes are always drafts.
	if (actor.kind === 'ai') return { needed: true, reason: 'ai' };
	const policy = def.approval;
	if (policy === 'never' || policy === 'ai') return { needed: false };
	if (policy === 'always') return { needed: true, reason: 'approval' };
	const can = (capability: string) => env.access.can(actor, capability);
	if (typeof policy === 'object') {
		if (actor.kind !== 'member' || can(policy.unless)) return { needed: false };
		const capability = policy.unless;
		if (policy.except) {
			if (!facts) return { needed: 'unknown', missing: 'input', capability };
			if (policy.except(actor, facts.input) === true) return { needed: false, reason: 'except' };
		}
		// Their own thing: they act directly (see `ownerMayAct`).
		if (policy.owner && ownerMayAct(def, actor, env)) {
			if (!facts) return { needed: 'unknown', missing: 'input', capability };
			if (facts.owner === undefined) return { needed: 'unknown', missing: 'owner', capability };
			if (facts.owner !== null && facts.owner === actor.memberId)
				return { needed: false, reason: 'owner' };
		}
		return { needed: true, reason: 'approval', capability };
	}
	if (!facts) return { needed: 'unknown', missing: 'input', capability: undefined };
	return policy(actor, facts.input, can) ? { needed: true, reason: 'approval' } : { needed: false };
}

/**
 * The one access decision: what happens if `actor` runs `def`, given the facts about the call
 * (none: the answer for any input, marked `depends` where an input could change it). The action
 * runner acts on it, and the app asks it before offering a control, so both always agree.
 */
export function decide(
	def: AnyActionDefinition,
	actor: Actor,
	env: DecideEnv,
	facts?: DecideFacts,
): Decision {
	const refusal = admission(def, actor, env);
	if (refusal) return { outcome: 'refuse', ...refusal };
	// An AI proposal that would change nothing is refused; whether it would, only the input says.
	const proposal = actor.kind === 'ai' && def.refuseProposal !== undefined;
	if (proposal && facts?.settled) return { outcome: 'refuse', reason: 'settled' };
	const needs = approval(def, actor, env, facts);
	if (needs.needed === false)
		return { outcome: 'apply', ...(needs.reason && { reason: needs.reason }) };
	const depends =
		needs.needed === 'unknown' || (proposal && !facts) ? { depends: true as const } : {};
	const capability = needs.capability;
	// Members without the capability may still propose, if their role allows proposing.
	if (actor.kind === 'member' && !env.access.can(actor, CORE_CAPABILITIES.draftsPropose.id)) {
		return {
			outcome: 'refuse',
			reason: 'approval',
			...(capability && { capability }),
			...depends,
		};
	}
	return {
		outcome: 'draft',
		reason: needs.needed === true ? needs.reason : 'approval',
		...(capability && { capability }),
		...depends,
	};
}

/** Whether the decision for these facts still waits for the policy's owner of the input. */
export function needsOwner(
	def: AnyActionDefinition,
	actor: Actor,
	env: DecideEnv,
	facts: DecideFacts,
): boolean {
	const needs = approval(def, actor, env, facts);
	return needs.needed === 'unknown' && needs.missing === 'owner';
}

/** Words for a refusal, for logs and API clients; they never name an action. */
const REFUSAL_TEXT: Record<AccessRefusal, string> = {
	capability: 'Your role does not allow this',
	approval: 'Your role does not allow this, not even as a suggestion',
	display: 'A display only shows; it cannot change anything',
	sign_in: 'Sign in first',
	ai: 'The AI may not do this for this person',
	critical: 'Only a person can do this, never the AI',
	area: 'The AI may not use this part of the app',
};

/**
 * The `forbidden` error of a refusal, with its reason and capability as `details`. A decision
 * that refuses for another reason (`settled`) is the caller's to say.
 */
export function refusalError(refusal: { reason?: string; capability?: string }): FamosError {
	const reason = isAccessRefusal(refusal.reason) ? refusal.reason : 'capability';
	return new FamosError('forbidden', REFUSAL_TEXT[reason], {
		reason,
		...(refusal.capability && { capability: refusal.capability }),
	});
}
