import { defineEvent, FamosError, selfOf, type UnitOfWork } from '@famos/sdk';
import { homeChangedPayload } from '../contract/index.ts';
import { type HomeRow, tables } from './store.ts';

export const homeChanged = defineEvent('home.changed', homeChangedPayload, {
	audience: 'home.view',
	// A home, its items and its services are one thing to a reader: the home changed.
	changes: ({ homeId }) => (homeId ? [{ entity: 'home', id: homeId, op: 'upsert' as const }] : []),
});

export const memberId = selfOf;

export async function loadHome(uow: UnitOfWork, id: string): Promise<HomeRow> {
	const row = await tables(uow.db)
		.selectFrom('home_homes')
		.selectAll()
		.where('id', '=', id)
		.where('archived_at', 'is', null)
		.executeTakeFirst();
	if (!row) throw new FamosError('not_found', 'Home not found');
	return row;
}
