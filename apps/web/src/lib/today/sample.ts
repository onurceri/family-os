import { addDays, epochOf, todayIn } from '@famos/time';
import type { TimelineItem } from '@famos/ui/slots';
import { t } from '#lib/i18n.svelte.js';
import { type SamplePerson, samplePeople } from './sample-people.js';
import type { TodaySample } from './today-data.svelte.js';

/** The made-up events are drawn as links, like real ones; the picture is inert, so where is moot. */
const SAMPLE_HREF = '/';

/**
 * The made-up day the style previews show (Settings → Appearance): three people and a
 * family plan, at a quarter past ten this morning in the family's time zone, so every style shows
 * a next thing, a past thing, the people and their chores. Every word comes from the catalog.
 */
export function sampleDay(
	timeZone: string,
	people: [SamplePerson, SamplePerson, SamplePerson] = samplePeople([], t),
	now = Date.now(),
): TodaySample {
	const [A, B, C] = people.map((p) => p.id) as [string, string, string];
	const today = todayIn(timeZone, now);
	const tomorrow = addDays(today, 1);
	const at = (day: string, time: string) => epochOf(day, time, timeZone);
	const item = (
		id: string,
		day: string,
		from: string,
		to: string,
		title: string,
		members: string[],
		location?: string,
	): TimelineItem => ({
		id: `sample:${id}`,
		start: at(day, from),
		end: at(day, to),
		title,
		members,
		kind: 'event',
		href: SAMPLE_HREF,
		...(location && { location, subtitle: location }),
	});

	const members = people.map((p) => ({ ...p, roleId: 'member', about: null }));
	return {
		now: at(today, '10:15'),
		members,
		me: { id: A, displayName: people[0].displayName, nextUp: 'family' },
		todayItems: [
			{
				id: 'sample:library',
				slot: 'allday',
				title: t('appearance_sample_library'),
				members: [C],
				kind: 'event',
				href: SAMPLE_HREF,
			},
			item('dentist', today, '08:30', '09:15', t('appearance_sample_dentist'), [B]),
			item(
				'swim',
				today,
				'11:00',
				'12:00',
				t('appearance_sample_swim'),
				[C],
				t('appearance_sample_pool'),
			),
			item('meeting', today, '13:00', '14:30', t('appearance_sample_meeting'), [A]),
			item(
				'piano',
				today,
				'15:30',
				'16:15',
				t('appearance_sample_piano'),
				[B],
				t('appearance_sample_music_school'),
			),
			item('football', today, '17:00', '18:00', t('appearance_sample_football'), [C]),
			item('dinner', today, '19:00', '21:00', t('appearance_sample_dinner'), []),
		],
		tomorrowItems: [
			item('haircut', tomorrow, '09:00', '09:45', t('appearance_sample_haircut'), [A]),
			item('market', tomorrow, '11:00', '12:00', t('appearance_sample_market'), []),
		],
		chores: [
			{ memberId: A, done: 1, total: 2 },
			{ memberId: B, done: 2, total: 3 },
			{ memberId: C, done: 0, total: 2 },
		],
	};
}
