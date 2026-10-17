import type { MemberStatusFacet, TodayBlockContribution } from '@famos/ui/slots';
import { loadPresence } from './data.js';
import { presenceNotes } from './presence-words.js';

/** Who is home, as a block of Today that a person, the family or a display may hide. */
export const presenceBlock: TodayBlockContribution = {
	id: 'homeassistant.presence',
	labelKey: 'homeassistant:presence_block',
	hintKey: 'homeassistant:presence_block_hint',
	// Just after where everyone is (70).
	order: 75,
};

/**
 * Home, Away or the place beside each name, for the people who chose to show it. Read through
 * `GET /presence`, which a display granted it may call (and which then answers only for those
 * who chose displays too). Someone coming home is no event of FamilyOS, so it reads again each
 * minute, as often as the server asks Home Assistant.
 */
export const presenceToday: MemberStatusFacet = {
	kind: 'memberStatus',
	id: 'homeassistant.presence',
	requires: 'homeassistant.presence',
	block: presenceBlock.id,
	refreshMs: 60_000,
	invalidateOn: ['homeassistant.people', 'homeassistant.connection'],
	load: async (app) =>
		presenceNotes(await loadPresence(), (key, options) => app.t(`homeassistant:${key}`, options)),
};
