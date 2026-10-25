import type { TodayFacet } from '@famos/ui/slots';
import { facetsOf } from '#lib/contributions.js';
import { contributions, enabledOnly } from '#lib/extensions.js';
import { type TodayBlock, todayBlocks } from '../blocks.js';
import type { Card } from './types.js';

/**
 * What a display may be granted for Today in family mode, offered when pairing besides what the
 * `display.*` slots name: what the timelines (the day), the facets a display shows (counts per
 * person, the photo, the weather's hours), the weather and the cards with a glance need.
 */
export function familyModeCapabilities(): string[] {
	return [
		...new Set([
			...contributions.timelines.map((c) => c.requires),
			...contributions.facets.filter((f) => f.kind !== 'setupHint').map((f) => f.requires),
			...contributions.slots.flatMap((c) =>
				c.slot === 'today.atmosphere' || (c.slot === 'dashboard.card' && c.glance === true)
					? [c.requires]
					: [],
			),
		]),
	];
}

/** An extension's name key (Settings → Features), for a card without a `labelKey` of its own. */
export const extensionLabel = (id: string): string | undefined =>
	contributions.extension(id)?.labelKey;

/** The first facet of a kind from an extension that is turned on, whoever views. */
export const providedFacet = <K extends TodayFacet['kind']>(kind: K, off: readonly string[]) =>
	facetsOf(contributions.facets, kind, { can: () => true, disabledExtensions: off })[0];

/** What the app's own blocks need (the weather, the photo), from extensions that are turned on. */
export const providers = (off: readonly string[]) => ({
	weather:
		providedFacet('weather', off) !== undefined ||
		enabledOnly(
			contributions.slots.filter((c) => c.slot === 'today.atmosphere'),
			off,
		).length > 0,
	photo: providedFacet('photo', off) !== undefined,
});

/**
 * The blocks "What Today shows" offers to a viewer: a person (the cards they may see), the
 * family's default (every card that is on: people differ in what they may see) or a display
 * (`familyMode`: only cards with a glance, no person-only blocks).
 */
export function availableTodayBlocks(viewer: {
	familyMode?: boolean;
	can?: (capability: string) => boolean;
	disabledExtensions: readonly string[];
}): TodayBlock[] {
	const cards = enabledOnly(
		contributions.slots.filter(
			(c): c is Card =>
				c.slot === 'dashboard.card' &&
				(!viewer.familyMode || c.glance === true) &&
				(!viewer.can || !c.requires || viewer.can(c.requires)),
		),
		viewer.disabledExtensions,
	).toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0));
	return todayBlocks(cards, {
		familyMode: viewer.familyMode ?? false,
		added: enabledOnly(contributions.blocks, viewer.disabledExtensions),
		provided: providers(viewer.disabledExtensions),
		extensionLabel,
	});
}
