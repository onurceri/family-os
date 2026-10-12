import { describe, expect, it } from 'vitest';
import { nowBlock, systemPrompt } from '../src/server/prompt.ts';

const input = {
	today: '2026-10-08',
	weekday: 'Thursday',
	now: '14:05',
	weekStart: 1,
	timeZone: 'Europe/Istanbul',
	hourCycle: 'h23',
	asker: null,
	members: null,
	summary: null,
	hasTools: true,
	memories: [],
	records: [],
} as const;

describe('the language the assistant answers in', () => {
	it("names the person's language through Intl, not a hand-written list", () => {
		expect(systemPrompt({ ...input, locale: 'en' })).toContain('Answer in English');
		expect(systemPrompt({ ...input, locale: 'tr' })).toContain('Answer in Turkish');
		expect(systemPrompt({ ...input, locale: 'pt-BR' })).toContain('Answer in Brazilian Portuguese');
		expect(systemPrompt({ ...input, locale: 'de' })).toContain('Answer in German');
	});
});

describe('where now is', () => {
	it('gives the date, the time and what is left of the week', () => {
		const saturday = { today: '2026-10-10', weekday: 'Saturday', now: '11:30', timeZone: 'UTC' };
		expect(nowBlock({ ...saturday, weekStart: 1 })).toBe(
			'Now it is Saturday, 2026-10-10, 11:30 in the family time zone UTC. This week runs from Monday 2026-10-05 to Sunday 2026-10-11. Still ahead this week: the rest of today, Sunday 2026-10-11. The days before today are past.',
		);
		// A week that starts on Sunday ends on Saturday: only today is left.
		expect(nowBlock({ ...saturday, weekStart: 7 })).toContain(
			'This week runs from Sunday 2026-10-04 to Saturday 2026-10-10. Still ahead this week: the rest of today.',
		);
	});

	it('tells the model that past events are never coming up', () => {
		const prompt = systemPrompt({ ...input, locale: 'en' });
		expect(prompt).toContain('Now it is Thursday, 2026-10-08, 14:05');
		expect(prompt).toContain('Look it up from today, not from the start of the week');
		expect(prompt).toContain('never present it as coming up');
	});
});
