import { addDays, formatDate, todayIn, weekOf, zoned } from '@famos/time';
import type { Paper } from '../contract/index.js';
import { NOTE_PAPERS } from '../contract/index.js';
import type { BoardT } from './i18n.js';

/** Full class names, so Tailwind finds them. */
export const PAPER_CLASS: Record<Paper, string> = {
	'note-1': 'bg-note-1',
	'note-2': 'bg-note-2',
	'note-3': 'bg-note-3',
	'note-4': 'bg-note-4',
	'note-5': 'bg-note-5',
};
export { NOTE_PAPERS };

/** A number in [0, 1) from a note's id and a salt (FNV-1a), so each choice is fixed per note. */
function unitOf(id: string, salt: string): number {
	let hash = 2166136261;
	const key = `${salt}:${id}`;
	for (let i = 0; i < key.length; i++) {
		hash ^= key.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0) / 4294967296;
}

/** A slight, fixed tilt for a note, from its id: between −2° and 2°. */
export function tiltOf(id: string): number {
	return Math.round((unitOf(id, 'tilt') * 4 - 2) * 100) / 100;
}

/** The colours a push pin's head comes in (tokens); a pinned note's pin is always `accent`. */
export const PIN_COLORS = ['ink', 'info', 'sun'] as const;
export type Fastener =
	| { kind: 'pin'; color: (typeof PIN_COLORS)[number] | 'accent' }
	| { kind: 'tape' };

/** What holds a note on the cork: a push pin or a strip of tape, fixed per note. */
export function fastenerOf(note: { id: string; pinned: boolean }): Fastener {
	if (note.pinned) return { kind: 'pin', color: 'accent' };
	const unit = unitOf(note.id, 'fastener');
	// One note in three is taped; the rest share the three pin colours.
	if (unit < 1 / 3) return { kind: 'tape' };
	const color = PIN_COLORS[Math.floor((unit - 1 / 3) * 1.5 * PIN_COLORS.length)] ?? 'ink';
	return { kind: 'pin', color };
}

/** A note this short is written large, like a word scribbled on a sticky note. */
export const SHORT_NOTE_CHARS = 40;
export const isShortNote = (note: { text: string; hasPhoto: boolean }): boolean =>
	!note.hasPhoto && note.text.trim().length <= SHORT_NOTE_CHARS;

/** How long ago a note was put up, in words that need no language code. */
export function postedLabel(
	createdAt: number,
	now: number,
	t: BoardT,
	timeZone: string,
	locale: string,
): string {
	const minutes = Math.max(0, Math.floor((now - createdAt) / 60_000));
	if (minutes < 1) return t('time_now');
	if (minutes < 60) return t('time_minutes', { count: minutes });
	const today = todayIn(timeZone, now);
	const day = zoned(createdAt, timeZone).toPlainDate().toString();
	if (day === today) return t('time_hours', { count: Math.floor(minutes / 60) });
	if (day === addDays(today, -1)) return t('time_yesterday');
	return formatDate(day, locale, { day: 'numeric', month: 'short' });
}

/** "Until Fri", "Until tomorrow": the end of a note, with dates in the date locale. */
export function untilLabel(
	endsOn: string,
	now: number,
	t: BoardT,
	timeZone: string,
	locale: string,
): string {
	const today = todayIn(timeZone, now);
	if (endsOn === today) return t('until_chip_today');
	if (endsOn === addDays(today, 1)) return t('until_chip_tomorrow');
	const soon = endsOn <= addDays(today, 6);
	return t('until_chip', {
		when: formatDate(
			endsOn,
			locale,
			soon ? { weekday: 'short' } : { day: 'numeric', month: 'short' },
		),
	});
}

/** The last day of the week that contains `today`, for "until the end of the week". */
export const endOfWeek = (today: string, weekStart: number): string =>
	weekOf(today, weekStart)[6] ?? today;
