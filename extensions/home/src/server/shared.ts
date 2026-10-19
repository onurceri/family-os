import { type Actor, defineEvent, FamosError, type UnitOfWork } from '@famos/sdk';
import { homeChangedPayload } from '../contract/index.ts';
import { type HomeRow, tables } from './store.ts';

export const homeChanged = defineEvent('home.changed', homeChangedPayload, {
	audience: 'home.view',
});

export const memberId = (actor: Actor) => (actor.kind === 'member' ? actor.memberId : null);

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
