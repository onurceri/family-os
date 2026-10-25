import {
	type AnyActionDefinition,
	compareThing,
	type DraftAlternative,
	subjectOf,
	targetOf,
} from '@famos/sdk';
import { ownerOf } from '../features.ts';
import { readStoredInput } from '../stored-input.ts';
import type { DraftRow } from '../tables.ts';
import type { Admission } from './admission.ts';
import type { ActionRunnerDeps } from './types.ts';

/**
 * What a reviewer is shown beside a draft: whether it seems done already, what it could be
 * instead, what its fields hold now, and what it is about by name. Only hints: none throws.
 */
export function createHints(deps: ActionRunnerDeps, { readContext }: Admission) {
	const { registry, logger } = deps;
	/** Whether what an input proposes seems to exist already; only a hint, it never throws. */
	async function seemsToExist(
		def: AnyActionDefinition,
		input: unknown,
		what: Record<string, string>,
	): Promise<boolean | 'some'> {
		if (!def.alreadyThere || !deps.features.isOn(ownerOf(def.id))) return false;
		try {
			return await def.alreadyThere(readContext(def), input);
		} catch (error) {
			logger.warn({ err: error, ...what }, 'duplicate check failed');
			return false;
		}
	}

	async function mayExist(draft: DraftRow): Promise<boolean | 'some'> {
		if (draft.status !== 'pending') return false;
		const def = registry.actions.get(draft.action_id);
		if (!def) return false;
		const input = def.input.safeParse(readStoredInput(def, draft.edited_input ?? draft.input));
		if (!input.success) return false;
		return seemsToExist(def, input.data, { draftId: draft.id });
	}

	/**
	 * The alternative an action offers for an input, checked the way a proposal of that action is:
	 * a known, enabled, data-changing action, a valid input with names resolved, a target that
	 * exists and that the change would really change. Only a hint: it never throws.
	 */
	async function alternativeOf(
		def: AnyActionDefinition,
		input: unknown,
		what: Record<string, string>,
	): Promise<DraftAlternative | null> {
		if (!def.instead || !deps.features.isOn(ownerOf(def.id))) return null;
		try {
			const offered = await def.instead(readContext(def), input);
			if (!offered) return null;
			const next = registry.actions.get(offered.actionId);
			if (!next || next.readOnly || !deps.features.isOn(ownerOf(next.id))) return null;
			const parsed = next.input.safeParse(offered.input);
			if (!parsed.success) return null;
			const ctx = readContext(next);
			const resolved = next.resolveNames ? await next.resolveNames(ctx, parsed.data) : parsed.data;
			const title = next.targetTitle ? await next.targetTitle(ctx, resolved) : null;
			// The draft's own words must name what it would change, as an AI's label must: an
			// alternative is never the closest thing, whatever the action offering it found. A
			// match a person is asked to check (the same code, other forms of the words) is offered:
			// the person chooses it or not.
			const said = subjectOf(JSON.stringify(input));
			if (next.targetTitle) {
				const { locale } = await ctx.family.settings();
				if (title === null || !said) return null;
				const match = compareThing(said, title, { language: locale });
				if (targetOf({ ...match, candidates: [title] }) === null) return null;
			}
			if (next.refuseProposal && (await next.refuseProposal(ctx, resolved)) !== null) return null;
			// Stored like every draft of that action: with the real title of what it changes.
			const stored = title ? { ...(resolved as object), label: title.slice(0, 200) } : resolved;
			return {
				actionId: next.id,
				input: stored,
				...(offered.at && { at: offered.at }),
				...(offered.to && { to: offered.to }),
				...(offered.key && { key: offered.key }),
			};
		} catch (error) {
			logger.warn({ err: error, ...what }, 'finding an alternative failed');
			return null;
		}
	}

	async function alternative(draft: DraftRow): Promise<DraftAlternative | null> {
		if (draft.status !== 'pending') return null;
		const def = registry.actions.get(draft.action_id);
		if (!def?.instead) return null;
		const input = def.input.safeParse(readStoredInput(def, draft.input));
		if (!input.success) return null;
		return alternativeOf(def, input.data, { draftId: draft.id });
	}

	async function currentValues(draft: DraftRow): Promise<Record<string, unknown> | null> {
		if (draft.status !== 'pending' && draft.status !== 'failed') return null;
		const def = registry.actions.get(draft.action_id);
		if (!def?.currentValues || !deps.features.isOn(ownerOf(def.id))) return null;
		// The reviewer reads the draft as it would be approved: with a saved edit when there is one.
		const input = def.input.safeParse(readStoredInput(def, draft.edited_input ?? draft.input));
		if (!input.success) return null;
		try {
			return await def.currentValues(readContext(def), input.data);
		} catch (error) {
			logger.warn({ err: error, draftId: draft.id }, 'reading the current values failed');
			return null;
		}
	}

	/** The action's `subject` for an input; only a hint, it never throws. */
	async function namedSubject(def: AnyActionDefinition, input: unknown): Promise<string | null> {
		if (!def.subject) return null;
		try {
			return await def.subject(readContext(def), input);
		} catch (error) {
			logger.warn({ err: error, actionId: def.id }, 'naming the subject failed');
			return null;
		}
	}

	/**
	 * What a draft is about, by name: what its input says (the label stored with it), else what
	 * the thing it points at is called now (for a draft stored before it carried the name).
	 */
	async function subjectOfDraft(draft: DraftRow): Promise<string | null> {
		const raw = draft.edited_input ?? draft.input;
		const named = subjectOf(raw);
		if (named) return named;
		const def = registry.actions.get(draft.action_id);
		if (!def || (!def.targetTitle && !def.subject) || !deps.features.isOn(ownerOf(def.id)))
			return null;
		try {
			const input = def.input.safeParse(readStoredInput(def, raw));
			if (!input.success) return null;
			const name = def.targetTitle
				? await def.targetTitle(readContext(def), input.data)
				: await namedSubject(def, input.data);
			return name?.trim().slice(0, 80) || null;
		} catch (error) {
			logger.warn({ err: error, draftId: draft.id }, 'naming the subject failed');
			return null;
		}
	}

	return {
		seemsToExist,
		mayExist,
		alternativeOf,
		alternative,
		currentValues,
		namedSubject,
		subjectOfDraft,
	};
}

export type Hints = ReturnType<typeof createHints>;
