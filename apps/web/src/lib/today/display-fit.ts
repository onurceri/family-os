import { isTimed } from '@famos/ui/famos';
import type { TimelineItem } from '@famos/ui/slots';
import type { Snippet } from 'svelte';
import type { FitDrop } from './fit-plan.js';
import type { TodayData } from './today-data.svelte.js';

export type { FitDrop };

/**
 * How a composition fits a family display's one screen (the display measures and chooses; see
 * `FamilyToday`, the plans `fit-plan.ts`). Each style reads it in its own way: fewer things per
 * person (`tight`), blocks left out (`drop`), its widgets and smaller blocks moved to where there
 * is room (`shift`). Never set on a person's Today.
 */
export interface DisplayFit {
	/** 0: the style's own limits; 1 to 3: fewer things per person (a column, a lane, a list). */
	readonly tight: number;
	readonly drop: ReadonlySet<FitDrop>;
	/** The style moves its widget band and smaller blocks to the column with room. */
	readonly shift: boolean;
	/** The display is still measuring: the composition stays hidden although it has settled. */
	readonly hold: boolean;
	/** The composition says it has settled (its content is in), so it can be measured. */
	ready(): void;
}

/**
 * What a composition takes: the data, and on a family display the display's pills (`status`),
 * which take the place of the bell in the head, how it must fit the screen (`fit`) and the band
 * of widgets (`band`).
 */
export interface CompositionProps {
	data: TodayData;
	status?: Snippet;
	fit?: DisplayFit;
	/** A display's widget band: the style puts it where it has room (after the day). */
	band?: Snippet;
}

/** A limit by tightness: `steps[tight]`, the last one for anything tighter. */
export const byTightness = (fit: DisplayFit | undefined, steps: readonly number[]): number =>
	steps[Math.min(fit?.tight ?? 0, steps.length - 1)] ?? steps[0] ?? 0;

/**
 * A display's list cut towards `max`: things that have ended leave first, so what is still to
 * come stays in view (the rest is the list's own "+n more").
 */
export function endedFirst(
	items: readonly TimelineItem[],
	max: number,
	now: number,
): readonly TimelineItem[] {
	let over = items.length - max;
	if (over <= 0) return items;
	return items.filter((item) => {
		if (over > 0 && isTimed(item) && (item.end ?? item.start ?? 0) <= now) {
			over--;
			return false;
		}
		return true;
	});
}
