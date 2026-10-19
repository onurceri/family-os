import { describe, expect, it } from 'vitest';
import {
	FALLBACK_TOPICS,
	type QuestionTopic,
	resolveAskedPeople,
	resolveTopics,
	SpanSchema,
} from '../src/index.ts';

const MEMBERS = [
	{ id: 'm_mara', displayName: 'Mara Novak' },
	{ id: 'm_leo', displayName: 'Leo' },
	{ id: 'm_ivy', displayName: 'Ivy' },
	{ id: 'm_al', displayName: 'Alexander Hart' },
	{ id: 'm_alex2', displayName: 'Alexander Pine' },
	{ id: 'm_deniz', displayName: 'Deniz' },
];
// Catalog strings, as `ctx.vocabulary` returns them.
const SELF = ['me', 'my', 'mine', 'myself', 'i', 'benim'];
const EVERYONE = ['everyone', 'the whole family'];

const ask = (said: string[], asker: string | null = 'm_mara') =>
	resolveAskedPeople(said, MEMBERS, asker, SELF, { everyoneWords: EVERYONE });

describe('resolveAskedPeople', () => {
	it('reads a self-word as the asker', () => {
		expect(ask(['my'])).toEqual({
			people: [{ said: 'my', how: 'self', memberId: 'm_mara' }],
			ids: ['m_mara'],
			everyone: false,
			unmatched: [],
		});
		expect(ask(['me', 'I']).ids).toEqual(['m_mara']);
		// Words of the catalog come from any installed language.
		expect(ask(['benim']).people[0]?.how).toBe('self');
	});

	it('does not read a self-word inside a longer phrase or a name', () => {
		expect(ask(['my kids']).people[0]?.how).toBe('none');
		expect(ask(['Ivy']).people[0]?.how).toBe('member');
	});

	it('leaves a self-word unresolved when the asker is unknown', () => {
		const result = ask(['me'], null);
		expect(result.ids).toEqual([]);
		expect(result.unmatched).toEqual(['me']);
		expect(result.people[0]?.how).toBe('none');
	});

	it('matches whole words of a name, in any case and with a possessive', () => {
		expect(ask(['leo']).ids).toEqual(['m_leo']);
		expect(ask(['Deniz’in']).ids).toEqual(['m_deniz']);
		expect(ask(['Mara']).people[0]).toEqual({ said: 'Mara', how: 'member', memberId: 'm_mara' });
	});

	it('never matches inside a word', () => {
		// "Al" and "Iv" are parts of names, not names.
		expect(ask(['Al']).ids).toEqual([]);
		expect(ask(['Iv']).people[0]?.how).toBe('none');
		expect(ask(['Le']).ids).toEqual([]);
	});

	it('marks a name that fits several members as ambiguous and does not pick one', () => {
		const result = ask(['Alexander']);
		expect(result.ids).toEqual([]);
		expect(result.people[0]).toEqual({ said: 'Alexander', how: 'ambiguous', memberId: null });
		expect(result.unmatched).toEqual(['Alexander']);
		// The full name settles it.
		expect(ask(['Alexander Pine']).ids).toEqual(['m_alex2']);
	});

	it('asks which one when two members have exactly the same name', () => {
		const twins = [
			{ id: 'm_nina1', displayName: 'Nina' },
			{ id: 'm_nina2', displayName: 'Nina' },
			{ id: 'm_ivy', displayName: 'Ivy' },
		];
		const result = resolveAskedPeople(['Nina', 'Ivy'], twins, 'm_ivy', ['me']);
		expect(result.ids).toEqual(['m_ivy']);
		expect(result.people[0]).toEqual({ said: 'Nina', how: 'ambiguous', memberId: null });
		expect(result.unmatched).toEqual(['Nina']);
	});

	it('keeps a name that is no member in unmatched and the order and repeats under control', () => {
		const result = ask(['Leo', 'the dentist', 'Ivy', 'leo', 'me']);
		expect(result.ids).toEqual(['m_leo', 'm_ivy', 'm_mara']);
		expect(result.unmatched).toEqual(['the dentist']);
		expect(result.people.map((p) => p.how)).toEqual(['member', 'none', 'member', 'member', 'self']);
	});

	it('reads the catalog’s words for everyone, whole phrases only', () => {
		expect(ask(['the whole family'])).toMatchObject({ everyone: true, ids: [] });
		expect(ask(['the whole']).everyone).toBe(false);
	});

	it('skips empty names', () => {
		expect(ask(['', '  ', '...'])).toEqual({
			people: [],
			ids: [],
			everyone: false,
			unmatched: [],
		});
	});
});

const open = (...areas: string[]) => ({
	installed: new Set(['calendar', 'lists', 'kitchen', 'chores', ...areas]),
	access: (_area: string) => 'any' as const,
});

describe('resolveTopics', () => {
	it('opens the topics whose area is installed and open to the AI', () => {
		const { installed, access } = open();
		const topics: QuestionTopic[] = ['calendar', 'tasks', 'meals', 'suggestions'];
		expect(resolveTopics(topics, installed, access)).toEqual({
			open: topics,
			missing: [],
			fallback: false,
		});
	});

	it('names a topic whose extension is not installed', () => {
		const { installed, access } = open();
		expect(resolveTopics(['calendar', 'pets', 'home'], installed, access)).toEqual({
			open: ['calendar'],
			missing: [
				{ topic: 'pets', area: 'pets', why: 'not_installed' },
				{ topic: 'home', area: 'home', why: 'not_installed' },
			],
			fallback: false,
		});
	});

	it('names a topic the AI is kept from, and honours local-only for a local model', () => {
		const installed = new Set(['calendar', 'records']);
		const access = (area: string) => (area === 'records' ? ('local' as const) : ('off' as const));
		expect(resolveTopics(['calendar', 'records'], installed, access).missing).toEqual([
			{ topic: 'calendar', area: 'calendar', why: 'closed_to_ai' },
			{ topic: 'records', area: 'records', why: 'closed_to_ai' },
		]);
		expect(resolveTopics(['records'], installed, access, { local: true }).open).toEqual([
			'records',
		]);
	});

	it('always opens suggestions, which core keeps', () => {
		expect(resolveTopics(['suggestions'], [], () => 'off')).toMatchObject({
			open: ['suggestions'],
			missing: [],
		});
	});

	it('answers tasks and shopping from the same extension, and counts repeats once', () => {
		const result = resolveTopics(['tasks', 'shopping', 'tasks'], [], () => 'any');
		expect(result.open).toEqual([]);
		expect(result.missing.map((m) => [m.topic, m.area])).toEqual([
			['tasks', 'lists'],
			['shopping', 'lists'],
		]);
	});

	it('falls back to calendar and tasks when no topic was named', () => {
		const { installed, access } = open();
		expect(resolveTopics([], installed, access)).toEqual({
			open: [...FALLBACK_TOPICS],
			missing: [],
			fallback: true,
		});
		expect(resolveTopics([], ['calendar'], access).missing).toEqual([
			{ topic: 'tasks', area: 'lists', why: 'not_installed' },
		]);
	});
});

describe('SpanSchema', () => {
	it('takes the span of the understanding shape', () => {
		const parsed = SpanSchema.parse({
			said: 'until Friday',
			to: { text: 'Friday', weekday: 5 },
		});
		expect(parsed.to?.weekday).toBe(5);
		expect(() => SpanSchema.parse({ said: 'x', kind: 'year' })).toThrow();
	});
});
