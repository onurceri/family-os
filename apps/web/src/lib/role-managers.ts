/** The capability that lets a person change what each role may do. */
export const ROLES_MANAGE = 'core.roles.manage';

/**
 * The active members whose role lets them change what roles may do, in the family's order: the
 * people a "View only" page names as the ones to ask.
 */
export function roleManagersOf<M extends { roleId: string; archived?: boolean }>(
	roles: readonly { id: string; capabilities: readonly string[] }[],
	members: readonly M[],
): M[] {
	const managing = new Set(
		roles.filter((role) => role.capabilities.includes(ROLES_MANAGE)).map((role) => role.id),
	);
	return members.filter((member) => !member.archived && managing.has(member.roleId));
}
