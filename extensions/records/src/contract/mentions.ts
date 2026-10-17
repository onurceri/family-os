import { findTarget, type MentionContext, namedShares, type RefusalReason } from '@famos/sdk';

/** What `records.aiContext` calls the open obligations it lists. */
export const OBLIGATION_CONTEXT_KIND = 'obligation';

/** How `records.aiContext` names an obligation: its title, then its record in brackets. */
export const obligationContextLabel = (title: string, recordName: string): string =>
	`${title} (${recordName})`;

/** Whether an obligation as `records.aiContext` names it belongs to the record named so. */
export const isObligationOf = (label: string, recordName: string): boolean =>
	label.endsWith(` (${recordName})`);

/** Which record a mention is about, and whether that rests on a guess. */
export type RecordPick<T> =
	| { found: T; certain: boolean }
	| { refuse: Extract<RefusalReason, 'unknown' | 'ambiguous'> };

/**
 * Which of some records (a domain's own pets, vehicles, homes; or the household records a
 * reading listed) a mention's `about` words name, for a resolver:
 * 1. the one the words name that the shared text names too;
 * 2. else, while the text names none of them ("the car", with "Clio" the only car and the
 *    model writing its listed name), the one the words alone name, as a guess;
 * 3. without words, the only record (a guess unless the text names it), or the one the text
 *    names most; else `ambiguous`.
 * Words that name none of them are `unknown`: a pet that is not listed is never another pet.
 * The text naming one record while the words name another is `ambiguous`.
 */
export function pickRecord<T extends { label: string }>(
	ctx: Pick<MentionContext, 'target' | 'text'>,
	about: string | undefined,
	candidates: readonly T[],
): RecordPick<T> {
	if (candidates.length === 0) return { refuse: 'unknown' };
	const text = ctx.text?.trim() ? ctx.text : null;
	const shares = text
		? namedShares(
				text,
				candidates.map((c) => c.label),
			)
		: [];
	const named = shares.some((share) => share > 0);
	if (!about?.trim()) {
		const [only] = candidates;
		if (candidates.length === 1 && only) return { found: only, certain: named };
		const best = Math.max(0, ...shares);
		const top = candidates.filter((_, i) => best > 0 && shares[i] === best);
		const [chosen] = top;
		return top.length === 1 && chosen ? { found: chosen, certain: true } : { refuse: 'ambiguous' };
	}
	const said = ctx.target(about, candidates);
	if ('found' in said) return { found: said.found, certain: true };
	if ('ambiguous' in said) return { refuse: 'ambiguous' };
	if (text && named) {
		// The words do not name what the text names: one of them points elsewhere.
		const alone = findTarget(about, candidates);
		return 'none' in alone ? { refuse: 'unknown' } : { refuse: 'ambiguous' };
	}
	const alone = findTarget(about, candidates);
	if ('found' in alone) return { found: alone.found, certain: false };
	return 'ambiguous' in alone ? { refuse: 'ambiguous' } : { refuse: 'unknown' };
}
