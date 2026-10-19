import { type DbExecutor, defineAction, FamosError, personPresent } from '@famos/sdk';
import { z } from 'zod';
import { CORE_CAPABILITIES } from './core-capabilities.ts';
import { readJson, writeJson } from './settings-json.ts';

/**
 * Whose next thing the hero on Today shows: the family's (the default) or
 * the person's own. A per-member preference kept beside the theme and style choices in
 * `core_settings`; displays are always the family's and cannot choose.
 */
export const NEXT_UP_MODES = ['family', 'me'] as const;
export const NextUpModeSchema = z.enum(NEXT_UP_MODES);
export type NextUpMode = z.infer<typeof NextUpModeSchema>;

const KEY = 'today.nextUp';

/** Only the members who chose `me` are stored; everyone else is on the default. */
type Stored = { members?: Record<string, unknown> };

export async function readNextUp(db: DbExecutor, memberId: string): Promise<NextUpMode> {
	const stored = await readJson<Stored>(db, KEY, {});
	return stored.members?.[memberId] === 'me' ? 'me' : 'family';
}

export const setMyNextUp = defineAction({
	id: 'core.setMyNextUp',
	title: "Choose whose next thing Today's hero shows",
	input: z.object({ mode: NextUpModeSchema }),
	output: z.object({ mode: NextUpModeSchema }),
	// Everyone may choose how Today looks to them; it changes nothing for anyone else.
	requires: CORE_CAPABILITIES.notificationsReceive.id,
	approval: 'never',
	async run(uow, input) {
		if (!personPresent(uow.actor))
			throw new FamosError('bad_request', 'Only a person can choose whose next thing to show');
		const stored = await readJson<Stored>(uow.db, KEY, {});
		const members = { ...stored.members };
		if (input.mode === 'me') members[uow.actor.memberId] = 'me';
		else delete members[uow.actor.memberId];
		await writeJson(uow.db, KEY, { ...stored, members }, uow.clock.now());
		return { mode: input.mode };
	},
});
