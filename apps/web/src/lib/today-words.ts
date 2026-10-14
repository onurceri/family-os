import type { MemberDayWords, NextUpWords, StatusWords } from '@famos/ui/famos';
import type { t as translate } from './i18n.svelte.js';

/**
 * The words of Today's shared components, from the app's catalog and from the facets and blocks
 * extensions provide (`FacetWords`). The components and the model in `@famos/ui/famos` hold no
 * words; Today builds these once and hands them down.
 */
export type Translate = typeof translate;

/** Words that come with what extensions provide: the counts per person, the meals' heading. */
export interface FacetWords {
	counts?: {
		/** The section ("Chores today"). */
		title: string;
		/** Its short name ("Chores"). */
		label: string;
		ring(name: string, done: number, total: number): string;
		/** What is left for a person ("2 chores left"). */
		left(count: number): string;
	};
	meals?: string;
}

export interface TodayWords {
	nextUp: NextUpWords;
	status: StatusWords;
	day: MemberDayWords;
	/** The phone's one line for the people with nothing: "Nothing planned for Deniz and Amy." */
	nothingFor(names: string): string;
	family: string;
	anyone: string;
	/** The counts per person's short name, and one ring (from the `perMember` facet). */
	chores: string;
	choreRing(name: string, done: number, total: number): string;
	hourly: string;
	/** "From the photos · October 2025" (the month from `formatPhotoMonth`). */
	photo(month: string): string;
	/** Me with nothing more of mine today. */
	noneForMe: string;
	/** The toggle's choice could not be saved. */
	nextUpError: string;
	/** The label of the day by person while the hero shows the next thing. */
	restOfDay: string;
	/** The counts per person's section (from the facet), and the meals' heading (from their block). */
	choresToday: string;
	kitchen: string;
	/** Wall's rows of each person's next thing: "Who, next". */
	whoNext: string;
	/** "Deniz, Amy and Elif": the last name joined by the catalog's "and". */
	names(list: readonly string[]): string;
}

export function todayWords(t: Translate, extra: FacetWords = {}): TodayWords {
	return {
		nextUp: {
			nextUp: t('today_next_up'),
			toggle: t('today_next_up_toggle'),
			family: t('today_next_up_family'),
			me: t('today_next_up_me'),
			countdown: {
				toGo: t('today_countdown_to_go'),
				hours: t('today_countdown_hours'),
				starts: t('today_countdown_starts'),
				now: t('today_countdown_now'),
				inDuration: (duration) => t('today_countdown_in', { duration }),
				nowUntil: (time) => t('today_countdown_now_until', { time }),
			},
			pill: {
				at: (place) => t('today_pill_at', { place }),
				starts: (time) => t('today_pill_starts', { time }),
				until: (time) => t('today_pill_until', { time }),
			},
		},
		status: {
			soon: (title, duration) => t('today_status_soon', { title, duration }),
			at: (title, time) => t('today_status_at', { title, time }),
			until: (title, time) => t('today_status_until', { title, time }),
			choresLeft: (count) => extra.counts?.left(count) ?? '',
			nothing: t('today_status_nothing'),
		},
		day: {
			allDay: t('today_day_all_day'),
			more: (count) => t('today_day_more', { count }),
			nothing: t('today_day_nothing'),
			nothingMore: t('today_day_nothing_more'),
			followedBy: (list) => t('today_day_then', { list }),
		},
		nothingFor: (names) => t('today_day_nothing_for', { names }),
		family: t('today_family'),
		anyone: t('today_anyone'),
		chores: extra.counts?.label ?? '',
		choreRing: (name, done, total) => extra.counts?.ring(name, done, total) ?? '',
		hourly: t('today_hourly'),
		photo: (month) => t('today_photo', { month }),
		noneForMe: t('today_next_up_none'),
		nextUpError: t('today_next_up_error'),
		restOfDay: t('today_rest_title'),
		choresToday: extra.counts?.title ?? '',
		kitchen: extra.meals ?? '',
		whoNext: t('today_who_next'),
		names: (list) =>
			list.length <= 1
				? (list[0] ?? '')
				: t('today_names_and', { list: list.slice(0, -1).join(', '), last: list.at(-1) }),
	};
}
