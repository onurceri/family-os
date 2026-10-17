import { epochOf } from '@famos/time';
import type { TimelineItem } from '@famos/ui/slots';
import { describe, expect, it } from 'vitest';
import {
	AXIS,
	axisFor,
	chartItems,
	clusterColumns,
	foldedScale,
	fractionOf,
	GAP_HEIGHT,
	HOUR_HEIGHT,
	hasTimed,
	hoursOf,
	type LaneMember,
	layoutColumn,
	layoutLane,
	linearScale,
	MAX_COLUMNS,
	MAX_LANES,
	MIN_BLOCK_HEIGHT,
	MIN_BLOCK_PX,
	nowFraction,
	phonePeople,
	planLanes,
	rowsOf,
} from './chart.js';

/** Lanes' day chart: positions, the minimum width, overlaps, who gets a lane. */

const span = (id: string, from: string, to: string) => {
	const m = (hm: string) => {
		const [h, min] = hm.split(':').map(Number);
		return (h ?? 0) * 60 + (min ?? 0);
	};
	return { id, start: m(from), end: m(to) };
};
/** 15 hours at 100 px each. */
const WIDTH = 1500;

describe('the axis', () => {
	it('runs from 07:00 to 22:00 with a mark every hour', () => {
		expect(axisFor([])).toEqual({ from: 420, to: 1320 });
		expect(hoursOf(AXIS)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
	});

	it('widens to the whole hours around something outside it', () => {
		expect(axisFor([span('a', '06:30', '07:15'), span('b', '22:10', '22:40')])).toEqual({
			from: 360,
			to: 1380,
		});
		expect(axisFor([span('late', '23:30', '24:00')]).to).toBe(1440);
	});

	it('places a minute as a fraction, and the now-line only inside the axis', () => {
		expect(fractionOf(420, AXIS)).toBe(0);
		expect(fractionOf(870, AXIS)).toBe(0.5);
		expect(fractionOf(1400, AXIS)).toBe(1);
		expect(nowFraction(920, AXIS)).toBeCloseTo(500 / 900);
		expect(nowFraction(400, AXIS)).toBeNull();
		expect(nowFraction(null, AXIS)).toBeNull();
	});
});

describe('a lane', () => {
	it('puts a block at its hour and as long as it lasts', () => {
		const [b] = layoutLane([span('piano', '15:45', '18:00')], AXIS, WIDTH);
		expect(b?.left).toBeCloseTo(875);
		expect(b?.width).toBeCloseTo(225);
		expect(b?.row).toBe(0);
	});

	it(`never draws a block narrower than ${MIN_BLOCK_PX} px`, () => {
		const [b] = layoutLane([span('drop', '08:30', '08:45')], AXIS, WIDTH);
		expect(b?.left).toBeCloseTo(150);
		expect(b?.width).toBe(MIN_BLOCK_PX);
	});

	it('caps a block at the end of the axis', () => {
		const [late] = layoutLane([span('club', '21:30', '23:00')], AXIS, WIDTH);
		expect(late?.left).toBeCloseTo(1450);
		expect(late?.width).toBeCloseTo(50);
		const [short] = layoutLane([span('call', '21:00', '21:10')], AXIS, WIDTH);
		expect(short?.width).toBeCloseTo(100);
	});

	it('stacks overlapping blocks in two rows at most', () => {
		const blocks = layoutLane(
			[span('a', '17:00', '18:30'), span('b', '18:00', '18:30'), span('c', '18:10', '18:20')],
			AXIS,
			WIDTH,
		);
		expect(blocks.map((b) => b.row)).toEqual([0, 1, 1]);
		expect(rowsOf(blocks)).toBe(2);
		expect(rowsOf(layoutLane([span('a', '10:00', '11:00')], AXIS, WIDTH))).toBe(1);
	});

	it('counts the minimum width when finding overlaps; back to back stays on one row', () => {
		// 10:00–10:15 is drawn 112 px (to about 10:07 + 1 h), so 10:30 overlaps it.
		const short = layoutLane(
			[span('a', '10:00', '10:15'), span('b', '10:30', '11:30')],
			AXIS,
			WIDTH,
		);
		expect(short.map((b) => b.row)).toEqual([0, 1]);
		const after = layoutLane(
			[span('a', '10:00', '11:30'), span('b', '11:30', '12:30')],
			AXIS,
			WIDTH,
		);
		expect(after.map((b) => b.row)).toEqual([0, 0]);
	});
});

describe('the calendar cluster layout', () => {
	it('gives overlapping spans columns and keeps the input order', () => {
		expect(
			clusterColumns([
				span('b', '10:30', '11:00'),
				span('a', '10:00', '11:00'),
				span('c', '12:00', '13:00'),
			]),
		).toEqual([
			{ id: 'b', column: 1, columns: 2 },
			{ id: 'a', column: 0, columns: 2 },
			{ id: 'c', column: 0, columns: 1 },
		]);
	});
});

describe("the phone's column", () => {
	it('places blocks by height with a minimum; an overlap moves below the block above it', () => {
		// 15 hours over 900 px: 60 px an hour.
		const blocks = layoutColumn(
			[span('a', '17:00', '18:30'), span('b', '18:00', '18:15'), span('c', '20:00', '20:10')],
			linearScale(AXIS, 900),
		);
		expect(blocks[0]).toEqual({ id: 'a', top: 600, height: 90 });
		// 18:00 is at 660, under "a" (to 690): it starts at 692 and keeps its minimum.
		expect(blocks[1]).toEqual({ id: 'b', top: 692, height: MIN_BLOCK_HEIGHT });
		expect(blocks[2]).toEqual({ id: 'c', top: 780, height: MIN_BLOCK_HEIGHT });
	});

	it('gives a block with a longer title its own minimum, and the hour grows to hold it', () => {
		const min = (id: string) => (id === 'long-title' ? 70 : MIN_BLOCK_HEIGHT);
		const spans = [span('long-title', '19:00', '19:15'), span('b', '19:30', '20:00')];
		const scale = foldedScale([spans], AXIS, { minPx: min });
		expect(scale.segments.find((s) => s.from === 19 * 60)?.height).toBe(
			70 + 2 + MIN_BLOCK_HEIGHT + 2,
		);
		const [a, b] = layoutColumn(spans, scale, min);
		expect(a?.height).toBe(70);
		expect(b?.top).toBe((a?.top ?? 0) + 72);
	});

	it('keeps a long stretch in its place behind the blocks, never pushing them', () => {
		const blocks = layoutColumn(
			[span('work', '08:00', '17:00'), span('call', '09:00', '09:30')],
			linearScale(AXIS, 900),
			MIN_BLOCK_HEIGHT,
			new Set(['work']),
		);
		expect(blocks[0]).toEqual({ id: 'work', top: 60, height: 540 });
		expect(blocks[1]).toEqual({ id: 'call', top: 120, height: MIN_BLOCK_HEIGHT });
	});
});

describe("the phone's folded axis", () => {
	it('folds two or more empty hours into a gap and keeps a single empty hour', () => {
		const scale = foldedScale([[span('a', '09:00', '10:00')], [span('b', '11:00', '12:30')]], AXIS);
		expect(scale.segments.map((s) => [s.from / 60, s.to / 60, s.gap])).toEqual([
			[7, 9, true],
			[9, 10, false],
			[10, 11, false],
			[11, 12, false],
			[12, 13, false],
			[13, 22, true],
		]);
		// The single empty hour (10–11) is drawn at half height.
		expect(scale.height).toBe(GAP_HEIGHT * 2 + HOUR_HEIGHT * 3 + HOUR_HEIGHT / 2);
		// 09:15 is a quarter into the first drawn hour, after the 07–09 gap.
		expect(scale.y(9 * 60 + 15)).toBe(GAP_HEIGHT + HOUR_HEIGHT / 4);
		// Inside a gap a minute sits in proportion.
		expect(scale.y(8 * 60)).toBe(GAP_HEIGHT / 2);
	});

	it('keeps the hour of the now-line, and a long stretch only for its first hour', () => {
		const scale = foldedScale([[span('work', '08:00', '17:00')]], AXIS, {
			keep: [15 * 60 + 20, null],
			long: new Set(['work']),
		});
		expect(scale.segments.filter((s) => !s.gap).map((s) => s.from / 60)).toEqual([7, 8, 15]);
		expect(scale.segments.filter((s) => s.gap).map((s) => [s.from / 60, s.to / 60])).toEqual([
			[9, 15],
			[16, 22],
		]);
		// Seven to eight is one empty hour: drawn at half height, not folded.
		expect(scale.segments[0]).toMatchObject({
			from: 420,
			to: 480,
			gap: false,
			height: HOUR_HEIGHT / 2,
		});
	});

	it('keeps the next hour when a block runs past its own at its minimum height', () => {
		// 08:30–09:00 at 44 px starts 24 px into a 48 px hour: it needs some of nine o'clock.
		const scale = foldedScale([[span('drop', '08:30', '09:00')]], AXIS);
		expect(scale.segments.filter((s) => !s.gap).map((s) => s.from / 60)).toEqual([7, 8, 9]);
		// On the hour it fits.
		const fits = foldedScale([[span('drop', '08:00', '08:30')]], AXIS);
		expect(fits.segments.filter((s) => !s.gap).map((s) => s.from / 60)).toEqual([7, 8]);
	});

	it('folds a day with nothing into one gap', () => {
		const scale = foldedScale([[], []], AXIS);
		expect(scale.segments).toEqual([
			{ from: 420, to: 1320, gap: true, top: 0, height: GAP_HEIGHT },
		]);
	});

	it('grows an hour where a column has several blocks starting', () => {
		const scale = foldedScale(
			[[span('a', '19:00', '21:00'), span('b', '19:00', '20:00'), span('c', '19:30', '19:45')]],
			AXIS,
		);
		const seven = scale.segments.find((s) => s.from === 19 * 60);
		expect(seven?.height).toBe(3 * (MIN_BLOCK_HEIGHT + 2));
	});
});

describe('who gets a lane', () => {
	const people: LaneMember[] = ['Deniz', 'Amy', 'Elif', 'Kai', 'Ada', 'Ben', 'Cem'].map((n) => ({
		id: n.toLowerCase(),
		displayName: n,
		color: '#000',
	}));
	const items = [
		{ id: 'swim', members: ['elif'] },
		{ id: 'chess', members: ['cem'] },
		{ id: 'dinner', members: [] as string[] },
		{ id: 'trip', members: ['cem', 'ben'] },
	];
	const membersOf = (i: { members: readonly string[] }) => i.members;

	it('gives everyone a lane up to six', () => {
		const plan = planLanes(people.slice(0, 6), items, MAX_LANES, membersOf);
		expect(plan.people.map((p) => p.member.id)).toEqual([
			'deniz',
			'amy',
			'elif',
			'kai',
			'ada',
			'ben',
		]);
		expect(plan.others).toBeNull();
		expect(plan.family.map((i) => i.id)).toEqual(['dinner']);
		expect(plan.people[5]?.items.map((i) => i.id)).toEqual(['trip']);
	});

	it('puts the seventh person in "Others", keeping lanes for people who have something', () => {
		const plan = planLanes(people, items, MAX_LANES, membersOf);
		expect(plan.people).toHaveLength(6);
		// Cem and Ben have something, so they keep a lane; Ada (nothing, last of the rest) shares.
		expect(plan.people.map((p) => p.member.id)).toEqual([
			'deniz',
			'amy',
			'elif',
			'kai',
			'ben',
			'cem',
		]);
		expect(plan.others?.members.map((m) => m.id)).toEqual(['ada']);
		expect(plan.others?.items).toEqual([]);
	});

	it("shows a shared item once in the phone's Others column", () => {
		const plan = planLanes(people, items, MAX_COLUMNS, membersOf);
		expect(plan.people.map((p) => p.member.id)).toEqual(['deniz', 'amy', 'elif', 'ben', 'cem']);
		expect(plan.others?.members.map((m) => m.id)).toEqual(['kai', 'ada']);
		// Trip is Ben's and Cem's, both in Others: it is there once.
		const crowded = planLanes(people, items, 1, membersOf);
		expect(crowded.others?.items.map((i) => i.id)).toEqual(['chess', 'trip']);
	});
});

describe("the phone's columns", () => {
	it('fit everyone up to six columns, then five people (four beside the family) and Others', () => {
		expect(phonePeople(4, true)).toBe(4);
		expect(phonePeople(5, true)).toBe(5);
		expect(phonePeople(6, false)).toBe(6);
		expect(phonePeople(7, false)).toBe(5);
		expect(phonePeople(6, true)).toBe(4);
		expect(phonePeople(7, true)).toBe(4);
	});
});

describe("the day's items on the chart", () => {
	const zone = 'Europe/Istanbul';
	const day = '2026-10-08';
	const at = (hm: string) => epochOf(day, hm, zone);
	const item = (over: Partial<TimelineItem> & { id: string }): TimelineItem => ({
		title: over.id,
		kind: 'event',
		href: '/',
		...over,
	});

	it('draws events by minute, long ones hollow, meals an hour, all-day across, chores never', () => {
		const out = chartItems(
			[
				item({ id: 'chore', kind: 'chore', start: at('09:00') }),
				item({ id: 'piano', start: at('15:45'), end: at('16:30') }),
				item({ id: 'work', start: at('09:00'), end: at('17:00') }),
				item({ id: 'lunch', kind: 'meal', start: at('12:30'), nominal: true }),
				item({ id: 'wfh', slot: 'allday' }),
				item({ id: 'task', kind: 'task' }),
			],
			day,
			zone,
		);
		expect(out.map((c) => [c.item.id, c.kind, c.span.start, c.span.end])).toEqual([
			['wfh', 'allday', 0, 1440],
			['work', 'long', 540, 1020],
			['lunch', 'meal', 750, 810],
			['piano', 'event', 945, 990],
		]);
	});

	it('clips an event that crosses midnight to the day', () => {
		const [late] = chartItems(
			[item({ id: 'late', start: at('23:00'), end: epochOf('2026-10-09', '01:00', zone) })],
			day,
			zone,
		);
		expect(late?.span).toEqual({ id: 'late', start: 1380, end: 1440 });
	});
});

describe('a day with something timed', () => {
	const lane = (...kinds: ('event' | 'meal' | 'long' | 'allday')[]) => ({
		items: kinds.map((kind) => ({ kind })),
	});

	it('is a day where some lane has an event, a meal or a long thing', () => {
		expect(hasTimed([lane(), lane('event')])).toBe(true);
		expect(hasTimed([lane('meal')])).toBe(true);
		expect(hasTimed([lane('allday', 'long')])).toBe(true);
	});

	it('is not a day of empty lanes or all-day things only', () => {
		expect(hasTimed([])).toBe(false);
		expect(hasTimed([lane(), lane()])).toBe(false);
		expect(hasTimed([lane('allday'), lane('allday')])).toBe(false);
	});
});
