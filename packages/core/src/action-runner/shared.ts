import { FamosError, type ProposalRefusal, type ProposalRefusalDetails } from '@famos/sdk';
import { z } from 'zod';

/** The value a mark points at: a field of the input, or a part of one (`items.0.title`). */
export function fieldOf(input: unknown, mark: string): unknown {
	let at = input;
	for (const part of mark.split('.')) {
		if (at === null || typeof at !== 'object') return undefined;
		at = (at as Record<string, unknown>)[part];
	}
	return at;
}

/** Whether two values are the same JSON, whatever the order of their keys. */
export function sameValue(a: unknown, b: unknown): boolean {
	const stable = (value: unknown): string =>
		JSON.stringify(value, (_key, v: unknown) =>
			v && typeof v === 'object' && !Array.isArray(v)
				? Object.fromEntries(Object.entries(v).toSorted(([x], [y]) => x.localeCompare(y)))
				: v,
		) ?? 'undefined';
	return stable(a) === stable(b);
}

export function parseOrThrow<S extends z.ZodType>(
	schema: S,
	value: unknown,
	what: string,
): z.infer<S> {
	const result = schema.safeParse(value);
	if (!result.success)
		throw new FamosError('bad_request', `Invalid ${what}`, z.treeifyError(result.error));
	return result.data;
}

/**
 * Ends a refusal that settles the matter. A model that reads only "already ticked off" tends to
 * look for another way to do something for the same request (putting the item back on the list),
 * so the refusal tells it to stop and say so.
 */
export const CLOSED_MATTER = ' Tell the person this and do not suggest anything else for it.';

/** A person decided the outer act, so the actions it runs need no approval of their own. */
export const DECIDED = { decided: true } as const;

/** The `details.reason` of a refusal for an action run inside another that would need approval. */
export const NESTED_NEEDS_APPROVAL = 'nested_needs_approval';

/** A draft keeps at most this much of the message it rests on: a line on its card, not a copy. */
export const QUOTE_MAX = 300;

/**
 * The `details` of a refused AI proposal, so a caller can tell the person why it was left out
 * without reading the English message: what it asked for is already so (`settled`), it named
 * something other than what it pointed at (`other_target`) or only partly named it
 * (`unsure_target`), or it named nothing (`no_label`).
 * `subject` is what it was about, in the stored title or the model's words, when known.
 */
export const refusal = (
	refused: ProposalRefusal,
	subject?: string | null,
): ProposalRefusalDetails => ({
	refused,
	...(subject && { subject }),
});

/** `core_drafts.error` of a draft closed because what it was about no longer exists. */
export const GONE = 'gone';

/** What a target's table must have: its id column. */
export type RowWithId = { id: string; [column: string]: unknown };

/** `core_drafts.error` of a draft closed because what it asks for was already so. */
export const SETTLED = 'settled';
