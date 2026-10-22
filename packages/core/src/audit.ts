import type { Actor, Clock, DbExecutor } from '@famos/sdk';
import type { CoreTables } from './tables.ts';

/**
 * The audit log for changes that cannot run as actions: creating or setting a secret (a
 * password, a PIN, a key shown once, a device's cookie) happens in a route, outside the runner,
 * and records what was done here instead. A row says who did it, the route's operation id and
 * the id of what it touched, never the secret and never the input.
 */
export interface AuditTrail {
	/** On `db` when given (a transaction), so the row commits with the change it records. */
	record(actor: Actor, id: string, target?: string | null, db?: DbExecutor): Promise<void>;
}

export function createAuditTrail(deps: { db: DbExecutor; clock: Clock }): AuditTrail {
	return {
		async record(actor, id, target = null, db = deps.db) {
			await db
				.withTables<CoreTables>()
				.insertInto('core_audit_log')
				.values({
					at: deps.clock.now(),
					actor: JSON.stringify(actor),
					action_id: id,
					draft_id: null,
					outcome: 'applied',
					target,
				})
				.execute();
		},
	};
}
