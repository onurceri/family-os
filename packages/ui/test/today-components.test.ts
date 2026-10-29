import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	BigNumber,
	ChoreRings,
	Clock,
	DateLine,
	FamilyList,
	HourlyStrip,
	isNightHour,
	MemberDay,
	type MemberDayWords,
	NextUpHero,
	type NextUpWords,
	PhotoTile,
	Ring,
	type TodayFormat,
	WeatherBlock,
	WeatherIcon,
} from '../src/famos/index.js';
import type { TimelineItem } from '../src/slots.js';
import { cleanup, click, q, qa, render } from './helpers.js';

afterEach(cleanup);

const at = (hh: number, mm = 0) => Date.UTC(2026, 9, 8, hh, mm);
const fmt: TodayFormat = {
	formatLocale: 'en-GB',
	dateLocale: 'en-GB',
	hourCycle: 'h23',
	timeZone: 'UTC',
};
const elif = { displayName: 'Elif', color: 'var(--ink-soft)' };

const piano: TimelineItem = {
	id: 'piano',
	title: 'Piano lesson',
	kind: 'event',
	href: '/calendar',
	start: at(15, 45),
	end: at(16, 30),
	location: 'Music school',
	members: ['elif'],
};

const words: NextUpWords = {
	nextUp: 'Next up',
	toggle: 'Whose next thing',
	family: 'Family',
	me: 'Me',
	countdown: {
		toGo: 'to go',
		hours: 'hr',
		starts: 'starts',
		now: 'now',
		inDuration: (d) => `in ${d}`,
		nowUntil: (t) => `now, until ${t}`,
	},
	pill: { at: (p) => `At ${p}`, starts: (t) => `Starts ${t}`, until: (t) => `Until ${t}` },
};

const dayWords: MemberDayWords = {
	allDay: 'All day',
	more: (n) => `+${n} more`,
	nothing: 'Nothing planned.',
	nothingMore: 'Nothing more today',
	followedBy: (list) => `then ${list}`,
};

describe('NextUpHero', () => {
	it('renders the countdown, the pill and the Family | Me toggle for a person', () => {
		const onmode = vi.fn();
		const el = render(NextUpHero, {
			item: piano,
			now: at(15, 20),
			format: fmt,
			words,
			member: elif,
			mode: 'family',
			onmode,
		});
		const hero = q('[data-testid="next-up"]', el);
		expect(hero.getAttribute('aria-label')).toBe('Piano lesson, 15:45, in 25 minutes');
		expect(q('[data-testid="countdown"] .n', el).textContent).toBe('25');
		expect(q('[data-testid="countdown"] .u', el).textContent).toBe('minutes');
		expect(q('.pill', el).textContent).toBe('At Music school');
		expect(q('.caps', el).textContent).toBe('Next up · Elif');
		expect(q('.title a', el).getAttribute('href')).toBe('/calendar');

		const toggle = q('[role="radiogroup"]', el);
		expect(toggle.getAttribute('aria-label')).toBe('Whose next thing');
		const options = qa('[role="radio"]', toggle);
		expect(options.map((o) => [o.textContent, o.getAttribute('aria-checked')])).toEqual([
			['Family', 'true'],
			['Me', 'false'],
		]);
		click(options[1] as HTMLElement);
		expect(onmode).toHaveBeenCalledWith('me');
	});

	it('has no toggle and no link in family mode (a display)', () => {
		const el = render(NextUpHero, {
			item: piano,
			now: at(13, 50),
			format: fmt,
			words,
			familyMode: true,
			onmode: vi.fn(),
		});
		expect(q('[role="radiogroup"]', el)).toBeNull();
		expect(q('.title a', el)).toBeNull();
		expect(q('.caps', el).textContent).toBe('Next up');
		// Over an hour the face is compact: the hours, a small unit and the minutes.
		expect(q('[data-testid="countdown"] .n', el).textContent).toBe('1hr55');
		expect(q('[data-testid="countdown"] .hu', el).textContent).toBe('hr');
		expect(q('[data-testid="countdown"] .u', el).textContent).toBe('to go');
	});

	it('has no toggle without a way to save it, and shows the time from two hours', () => {
		const el = render(NextUpHero, {
			item: { ...piano, location: undefined },
			now: at(12),
			format: fmt,
			words,
		});
		expect(q('[role="radiogroup"]', el)).toBeNull();
		expect(q('[data-testid="countdown"] .n', el).textContent).toBe('15:45');
		expect(q('[data-testid="countdown"] .u', el).textContent).toBe('starts');
		// The countdown is the time, so the pill does not repeat it.
		expect(q('.pill', el)).toBeNull();
	});

	it('says now and until once started, in a ring when asked', () => {
		const el = render(NextUpHero, {
			item: piano,
			now: at(16),
			format: fmt,
			words,
			countdownVariant: 'ring',
		});
		expect(q('[data-testid="next-up"]', el).getAttribute('aria-label')).toBe(
			'Piano lesson, 15:45, now, until 16:30',
		);
		expect(q('[data-testid="countdown"] .n', el).textContent).toBe('now');
		expect(q('[data-testid="countdown"] [data-testid="ring"]', el)).not.toBeNull();
		expect(q('.pill', el).textContent).toBe('Until 16:30');
	});
});

describe('Ring and ChoreRings', () => {
	it('shows its value as text', () => {
		const el = render(Ring, { done: 1, total: 3, color: 'var(--ink-soft)' });
		expect(q('[data-testid="ring"]', el).textContent?.trim()).toBe('1/3');
		cleanup();
		const named = render(Ring, { done: 2, total: 2, name: 'Elif: 2 of 2 chores done' });
		const ring = q('[data-testid="ring"]', named);
		expect(ring.getAttribute('role')).toBe('img');
		expect(ring.getAttribute('aria-label')).toBe('Elif: 2 of 2 chores done');
	});

	it('draws a ring per person with the count inside and the name under it', () => {
		const el = render(ChoreRings, {
			label: 'Chores',
			rings: [
				{ id: 'elif', name: 'Elif', color: 'var(--ink-soft)', done: 1, total: 3 },
				{ id: 'anyone', name: 'Anyone', done: 0, total: 0 },
			],
			name: (r: { name: string; done: number; total: number }) =>
				`${r.name}: ${r.done} of ${r.total}`,
		});
		const items = qa('li', el);
		expect(items.map((li) => li.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
			'1/3 Elif',
			// Nothing to count is an empty ring: "0/0" would read as a score.
			'Anyone',
		]);
		expect(q('[data-testid="ring"]', items[1]).classList.contains('dim')).toBe(true);
		expect(q('[data-testid="ring"]', items[0]).getAttribute('aria-label')).toBe('Elif: 1 of 3');
	});
});

describe('MemberDay', () => {
	const items: TimelineItem[] = [
		{ id: 'wfh', title: 'Working from home', kind: 'event', href: '/', slot: 'allday' },
		{ ...piano, id: 'school', title: 'School', start: at(8), end: at(15), location: undefined },
		piano,
		{ ...piano, id: 'football', title: 'Football', start: at(17), end: at(18) },
	];

	it('column: a card per item up to the limit, past receded, next outlined, then +n more', () => {
		const el = render(MemberDay, {
			member: elif,
			items,
			now: at(15, 20),
			format: fmt,
			words: dayWords,
			nextId: 'piano',
		});
		const day = q('[data-testid="member-day"]', el);
		expect(day.classList.contains('column')).toBe(true);
		expect(day.getAttribute('aria-label')).toBe('Elif');
		const cards = qa('.card', day);
		expect(cards.map((c) => c.querySelector('time')?.textContent)).toEqual([
			'All day',
			'08:00',
			'15:45',
		]);
		expect(cards[1]?.classList.contains('past')).toBe(true);
		expect(cards[2]?.classList.contains('next')).toBe(true);
		expect(q('.more', day).textContent).toBe('+1 more');
	});

	it('column with nothing: the serif note and the chores line', () => {
		const el = render(MemberDay, {
			member: elif,
			items: [],
			now: at(12),
			format: fmt,
			words: dayWords,
			meta: '1 chore left',
		});
		expect(q('.free', el).textContent).toBe('Nothing planned.');
		expect(q('.free', el).classList.contains('font-serif')).toBe(true);
		expect(q('.more', el).textContent).toBe('1 chore left');
	});

	it('stack: two cards, the rule at the side', () => {
		const el = render(MemberDay, {
			member: elif,
			items,
			now: at(12),
			format: fmt,
			words: dayWords,
			variant: 'stack',
		});
		expect(q('[data-testid="member-day"]', el).classList.contains('stack')).toBe(true);
		expect(qa('.card', el)).toHaveLength(2);
		expect(q('.more', el).textContent).toBe('+2 more');
	});

	it('row: the next thing large with what follows, or nothing more today', () => {
		const el = render(MemberDay, {
			member: elif,
			items,
			now: at(15, 20),
			format: fmt,
			words: dayWords,
			variant: 'row',
			meta: '1 of 3 chores left',
		});
		expect(q('.nx time', el).textContent).toBe('15:45');
		expect(q('.nx .t b', el).textContent).toBe('Piano lesson');
		expect(q('.nx .t small', el).textContent).toBe('Music school · then Football 17:00');
		expect(q('.name small', el).textContent).toBe('1 of 3 chores left');
		cleanup();
		const late = render(MemberDay, {
			member: elif,
			items: items.slice(1),
			now: at(20),
			format: fmt,
			words: dayWords,
			variant: 'row',
			showName: false,
		});
		expect(q('.nx.free', late).textContent).toBe('Nothing more today');
		expect(q('.name', late).classList.contains('sr-only')).toBe(true);
	});
});

describe('the rest of the kit', () => {
	it('Clock and DateLine format in the format locale and hour cycle', () => {
		let el = render(Clock, { now: at(15, 45), format: fmt });
		expect(q('[data-testid="clock"]', el).textContent).toBe('15:45');
		cleanup();
		el = render(Clock, {
			now: at(15, 45),
			format: { ...fmt, dateLocale: 'en-US', hourCycle: 'h12' },
		});
		expect(q('[data-testid="clock"]', el).textContent).toBe('3:45PM');
		expect(q('.period', el).textContent).toBe('PM');
		cleanup();
		el = render(DateLine, { now: at(12), format: { ...fmt, dateLocale: 'tr-TR' } });
		expect(q('.weekday', el).textContent).toBe('Perşembe');
		expect(q('.date', el).textContent).toBe('8 Ekim');
	});

	it('WeatherBlock and HourlyStrip: degrees, the sentence and the hours', () => {
		const hours = [12, 13, 14].map((h, i) => ({
			at: at(h),
			temperature: 17 + i,
			code: i === 2 ? 61 : 1,
			precipitationProbability: 10,
		}));
		const el = render(WeatherBlock, {
			temperature: 16.6,
			format: fmt,
			summary: 'Sunny',
			sentence: 'Rain from 14:00.',
			hours,
			stripLabel: 'Next hours',
			condition: (code: number) => (code === 61 ? 'Rain' : 'Clear'),
		});
		expect(q('.temp', el).textContent).toBe('17°');
		expect(q('.say', el).textContent).toBe('Rain from 14:00.');
		const strip = q('[data-testid="hourly-strip"]', el);
		expect(strip.getAttribute('aria-label')).toBe('Next hours');
		const li = qa('li', strip);
		expect(li.map((h) => h.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
			'12 17° Clear',
			'13 18° Clear',
			'14 19° Rain',
		]);
		expect(li[2]?.classList.contains('wet')).toBe(true);
		cleanup();
		const bars = render(HourlyStrip, { hours, format: fmt, variant: 'bars', label: 'Next hours' });
		expect(qa('.bar', bars)).toHaveLength(3);
	});

	it('"Anyone" gets a people icon, never a letter that reads as a member\'s initial', () => {
		const anyone = { displayName: 'Anyone', color: 'var(--ink-soft)', anyone: true };
		for (const variant of ['column', 'row'] as const) {
			const el = render(MemberDay, {
				member: anyone,
				items: [],
				now: at(12),
				format: fmt,
				words: dayWords,
				variant,
			});
			expect(qa('[data-testid="anyone-avatar"]', el)).toHaveLength(1);
			expect(qa('.day', el)).toHaveLength(0);
			cleanup();
		}
	});

	it('isNightHour: the 06–20 rule in the time zone, or the sun when the forecast has it', () => {
		// UTC: 05:00 is night, 06:00 day, 19:00 day, 20:00 night.
		expect(isNightHour(at(5), 'UTC')).toBe(true);
		expect(isNightHour(at(6), 'UTC')).toBe(false);
		expect(isNightHour(at(19), 'UTC')).toBe(false);
		expect(isNightHour(at(20), 'UTC')).toBe(true);
		expect(isNightHour(at(23), 'UTC')).toBe(true);
		// The family's time zone, not UTC: 17:00 UTC is 20:00 in Istanbul (UTC+3).
		expect(isNightHour(at(17), 'Europe/Istanbul')).toBe(true);
		expect(isNightHour(at(3), 'Europe/Istanbul')).toBe(false);
		// With sunrise and sunset, the middle of the hour decides.
		const sun = [{ rise: at(7, 20), set: at(18, 40) }];
		expect(isNightHour(at(6), 'UTC', sun)).toBe(true);
		expect(isNightHour(at(7), 'UTC', sun)).toBe(false);
		expect(isNightHour(at(18), 'UTC', sun)).toBe(false);
		expect(isNightHour(at(19), 'UTC', sun)).toBe(true);
	});

	it('the strip draws a moon for a clear night hour and a sun by day', () => {
		const hours = [19, 20, 21].map((h) => ({ at: at(h), temperature: 12, code: h === 21 ? 2 : 0 }));
		const el = render(HourlyStrip, { hours, format: fmt, label: 'Next hours' });
		expect(qa('svg.wx', el).map((icon) => icon.dataset.shape)).toEqual([
			'clear',
			'clear-night',
			'partly-night',
		]);
		cleanup();
		// Rain keeps its cloud at night.
		const rain = render(WeatherIcon, { code: 61, night: true });
		expect(q('svg', rain).dataset.shape).toBe('rain');
	});

	it('FamilyList keeps each status to one line', () => {
		const el = render(FamilyList, {
			label: 'Family',
			people: [
				{ id: 'elif', displayName: 'Elif', color: 'var(--ink-soft)', status: 'Piano 15:45' },
			],
		});
		expect(q('small', el).textContent).toBe('Piano 15:45');
		expect(q('ul', el).getAttribute('aria-label')).toBe('Family');
	});

	it('BigNumber and PhotoTile', () => {
		let el = render(BigNumber, { value: 1234, formatLocale: 'tr-TR', title: 'items to get' });
		expect(q('.n', el).textContent).toBe('1.234');
		cleanup();
		el = render(PhotoTile, { src: '/p.jpg', label: 'From the photos · October 2025' });
		expect(q('figcaption', el).textContent).toBe('From the photos · October 2025');
		expect(q('img', el).getAttribute('src')).toBe('/p.jpg');
	});
});
