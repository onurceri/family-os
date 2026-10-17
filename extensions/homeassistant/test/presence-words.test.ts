import { describe, expect, it } from 'vitest';
import en from '../src/messages/en.json' with { type: 'json' };
import { type PresenceT, presenceNotes, presenceText } from '../src/web/presence-words.ts';

const t: PresenceT = (key, options) =>
	en[key].replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''));

describe('presence in words', () => {
	it('says Home, Away and the zone as Home Assistant names it', () => {
		expect(presenceText({ kind: 'home' }, t)).toBe('Home');
		expect(presenceText({ kind: 'away' }, t)).toBe('Away');
		expect(presenceText({ kind: 'place', name: 'School' }, t)).toBe('At School');
		expect(presenceText({ kind: 'unknown' }, t)).toBeNull();
	});

	it('gives Today a note for each person whose whereabouts are known', () => {
		expect(
			presenceNotes(
				{
					status: 'ok',
					people: [
						{ memberId: 'alex', presence: { kind: 'place', name: 'School' }, since: 1 },
						{ memberId: 'sam', presence: { kind: 'unknown' }, since: null },
						{ memberId: 'deniz', presence: { kind: 'home' }, since: 2 },
					],
				},
				t,
			),
		).toEqual([
			{ memberId: 'alex', text: 'At School' },
			{ memberId: 'deniz', text: 'Home' },
		]);
	});
});
