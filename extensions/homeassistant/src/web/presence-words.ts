import type { Presence, PresenceList } from '../contract/index.js';

/**
 * Where someone is, in words. Pure: the translator comes in, so the language decides how it
 * reads and a test needs no browser. A zone keeps the name Home Assistant gives it.
 */

export type PresenceWord = 'presence_home' | 'presence_away' | 'presence_place';

export type PresenceT = (key: PresenceWord, options?: Record<string, unknown>) => string;

/** "Home", "Away", "At School"; nothing for someone whose whereabouts are not known. */
export function presenceText(presence: Presence, t: PresenceT): string | null {
	switch (presence.kind) {
		case 'unknown':
			return null;
		case 'home':
			return t('presence_home');
		case 'away':
			return t('presence_away');
		case 'place':
			return t('presence_place', { place: presence.name });
	}
}

/** Today's notes beside the names: one per person whose whereabouts are known. */
export function presenceNotes(
	list: PresenceList,
	t: PresenceT,
): { memberId: string; text: string }[] {
	return list.people.flatMap((person) => {
		const text = presenceText(person.presence, t);
		// Without a name there is no one to put the note beside.
		return text && person.memberId ? [{ memberId: person.memberId, text }] : [];
	});
}
