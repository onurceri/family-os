import type { AmbientSettings, Place } from '../contract/index.js';

/**
 * What choosing a place does to the weather switch. The first place turns the weather on (the
 * switch refuses to turn on without one, so that is what the person came to do); changing the
 * place later leaves the switch as the family set it.
 */
export function placeChoice(
	current: AmbientSettings['weather'],
	place: Place,
): { enabled: boolean; place: Place; firstPlace: boolean } {
	const firstPlace = current.place === null;
	return { enabled: firstPlace ? true : current.enabled, place, firstPlace };
}
