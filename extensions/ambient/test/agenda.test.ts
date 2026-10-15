import { describe, expect, it } from 'vitest';
import { type AgendaEvent, nextEvents } from '../src/web/agenda.js';

const timeZone = 'UTC';
const at = (hhmm: string) => Date.parse(`2026-10-11T${hhmm}:00Z`);
const now = at('16:00');

const agenda: AgendaEvent[] = [
	{ id: 'a', title: 'Breakfast', start: at('08:00') },
	{ id: 'b', title: 'Started a moment ago', start: at('15:50') },
	{ id: 'c', title: 'Piano', start: at('16:30') },
	{ id: 'd', title: 'Dinner', start: at('19:05') },
	{ id: 'e', title: 'Late call', start: at('21:00') },
];

describe('nextEvents', () => {
	it('writes times on a 24-hour clock when the family uses one, even in an en-US format locale', () => {
		const events = nextEvents(agenda, now, { timeZone, dateLocale: 'en-US', hourCycle: 'h23' });
		expect(events.map((e) => e.time)).toEqual(['15:50', '16:30', '19:05']);
	});

	it('writes times on a 12-hour clock when the family uses one, without a leading zero', () => {
		const events = nextEvents(agenda, now, { timeZone, dateLocale: 'en-US', hourCycle: 'h12' });
		expect(events.map((e) => e.time.replace(/\s/g, ' '))).toEqual([
			'3:50 PM',
			'4:30 PM',
			'7:05 PM',
		]);
	});

	it('keeps events that started less than 15 minutes ago and drops older ones', () => {
		const events = nextEvents(agenda, now, { timeZone, dateLocale: 'en-GB', hourCycle: 'h23' });
		expect(events.map((e) => e.id)).toEqual(['b', 'c', 'd']);
	});

	it('uses the family time zone', () => {
		const [first] = nextEvents(agenda, now, {
			timeZone: 'Asia/Tokyo',
			dateLocale: 'en-GB',
			hourCycle: 'h23',
		});
		expect(first?.time).toBe('00:50');
	});
});
