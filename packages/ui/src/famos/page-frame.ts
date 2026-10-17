/**
 * The page templates and the width class each one sits in. Pages of
 * one width class share one frame: the same maximum width, centred the same way, so their titles
 * start at the same x.
 *
 * - `narrow`: 760 px, centred (Chat, Capture).
 * - `medium`: 60 rem, centred; a page whose sections sit side by side (`settings-pair`) opens up to
 *   76 rem from 80 rem of width (Settings).
 * - `standard`: 1200 px, centred (Lists, List + detail, Record).
 * - `full`: the whole content area between the shell's gutters (Day, Calendar); the Board also
 *   bleeds into the gutters, edge to edge.
 */
export const PAGE_TEMPLATES = [
	'list',
	'list-detail',
	'record',
	'chat',
	'capture',
	'board',
	'day',
	'settings',
	'calendar',
] as const;

export type PageTemplate = (typeof PAGE_TEMPLATES)[number];

export type PageWidth = 'narrow' | 'medium' | 'standard' | 'full';

export const PAGE_WIDTH: Record<PageTemplate, PageWidth> = {
	list: 'standard',
	'list-detail': 'standard',
	record: 'standard',
	chat: 'narrow',
	capture: 'narrow',
	board: 'full',
	day: 'full',
	settings: 'medium',
	calendar: 'full',
};
