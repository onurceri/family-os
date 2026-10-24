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
