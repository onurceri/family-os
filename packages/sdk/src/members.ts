import type { UnitOfWork } from './context.ts';
import { FamosError } from './errors.ts';

/**
 * Refuses a member id that is not an active member of the family, naming the input `field` so a
 * program can find it. Empty entries (an unset assignee) are skipped.
 */
export async function assertActiveMembers(
	uow: Pick<UnitOfWork, 'family'>,
	ids: readonly (string | null | undefined)[],
	field: string,
): Promise<void> {
	const wanted = ids.filter((id): id is string => !!id);
	if (wanted.length === 0) return;
	const active = new Set((await uow.family.members()).map((m) => m.id));
	const unknown = wanted.find((id) => !active.has(id));
	if (unknown)
		throw new FamosError('bad_request', `Unknown member: ${unknown}`, {
			fields: [{ path: field, message: 'Not a member of this family' }],
		});
}

/**
 * Member colors. Eight hues kept away from coral/red so a member's color never reads as
 * "attention", each tuned so letters on it reach 4.5:1. Assigned in order; an admin picks from
 * the same list.
 */
export const MEMBER_COLORS = [
	'#3d7aae',
	'#c38f22',
	'#975cbd',
	'#2f9a94',
	'#c66591',
	'#68778b',
	'#996c46',
	'#5c923d',
] as const;
