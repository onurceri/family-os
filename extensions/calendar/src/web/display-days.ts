import { addDays } from '@famos/time';

/** The days a wall shows: today and the six after it, so what is coming is never cut off by the week's edge. */
export function nextDays(today: string, count = 7): string[] {
	return Array.from({ length: count }, (_, i) => addDays(today, i));
}
