import type { UnitOfWork } from '@famos/sdk';
import { DEFAULT_AUDIENCE } from '../contract/index.ts';
import { tables } from './store.ts';

/**
 * Whether the caller may read what belongs to the area named by `audience`. Unknown audience (the
 * area's extension is gone): records.view.
 */
export const mayRead = (can: (capability: string) => boolean, audience: string) => {
	try {
		return can(audience);
	} catch {
		return can(DEFAULT_AUDIENCE);
	}
};

type Db = ReturnType<typeof tables>;

/**
 * The area a record's papers belong to. A paper keeps no area of its own: its record's duties name
 * it (a pet's are `pets.view`), and when the record has none yet, the duties of other records of
 * the same kind do, since a kind belongs to one area. Archived duties still count, so papers stay
 * in their area after a record is archived. A kind no duty has ever named is records.view.
 */
export async function paperAudience(db: Db, recordId: string, recordKind: string) {
	const areaOf = async (column: 'record_id' | 'record_kind', value: string) => {
		const row = await db
			.selectFrom('records_obligations')
			.select('audience')
			.where(column, '=', value)
			.where('audience', '!=', DEFAULT_AUDIENCE)
			.orderBy('id')
			.executeTakeFirst();
		return row?.audience;
	};
	return (
		(await areaOf('record_id', recordId)) ??
		(await areaOf('record_kind', recordKind)) ??
		DEFAULT_AUDIENCE
	);
}

/** Whether the unit of work's actor may see the papers of this record. */
export async function mayReadPapers(uow: UnitOfWork, recordId: string, recordKind: string) {
	return mayRead((c) => uow.can(c), await paperAudience(tables(uow.db), recordId, recordKind));
}

/** The audience to tell about this area: its own while its extension is installed, else records.view. */
export function knownAudience(uow: UnitOfWork, audience: string) {
	try {
		uow.can(audience);
		return audience;
	} catch {
		return DEFAULT_AUDIENCE;
	}
}
