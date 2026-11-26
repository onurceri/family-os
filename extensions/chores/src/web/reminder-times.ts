import { IsoTimeSchema } from '@famos/time';
import { LEFT_TODAY_MAX_TIMES } from '../contract/index.js';

/** Whether the list in the form may be saved: one to four different, valid times of day. */
export function timesProblem(times: string[]): 'empty' | 'invalid' | 'duplicate' | null {
	if (times.length === 0) return 'empty';
	if (times.some((time) => !IsoTimeSchema.safeParse(time).success)) return 'invalid';
	if (new Set(times).size !== times.length) return 'duplicate';
	return null;
}

export const mayAddTime = (times: string[]): boolean => times.length < LEFT_TODAY_MAX_TIMES;

/** A time to offer for a new row: the first full hour after the last one that is not listed. */
export function nextTime(times: string[]): string {
	const last = [...times].sort().at(-1);
	const start = last ? Number(last.slice(0, 2)) + 2 : 16;
	for (let step = 0; step < 24; step++) {
		const candidate = `${String((start + step) % 24).padStart(2, '0')}:00`;
		if (!times.includes(candidate)) return candidate;
	}
	return '12:00';
}
