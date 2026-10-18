import { describe, expect, it } from 'vitest';
import {
	createHandleTable,
	DIGEST_NOTES_MAX,
	DigestInputSchema,
	type DigestItem,
	DigestOutputSchema,
	defineDigest,
	digestAboutScore,
	digestForPeople,
	digestNotes,
	digestOf,
	rankDigest,
	readableOutput,
	withoutPaths,
} from '../src/index.ts';

const MEMBER = 'member_0192a3b4-0000-7000-8000-000000000001';

const item = (title: string, extra: Partial<DigestItem> = {}): DigestItem => ({
	handle: null,
	kind: 'event',
	title,
	date: '2026-10-22',
	people: [],
	...extra,
});

describe('DigestInputSchema', () => {
	it('takes a span of days with people and words', () => {
		const input = { from: '2026-10-19', to: '2026-10-25', memberIds: [MEMBER], about: ['pick up'] };
		expect(DigestInputSchema.parse(input)).toEqual(input);
	});

	it('refuses a span that ends before it starts or covers more than 62 days', () => {
		expect(DigestInputSchema.safeParse({ from: '2026-10-19', to: '2026-10-18' }).success).toBe(
			false,
		);
		expect(DigestInputSchema.safeParse({ from: '2026-10-01', to: '2026-12-02' }).success).toBe(
			true,
		);
		expect(DigestInputSchema.safeParse({ from: '2026-10-01', to: '2026-12-03' }).success).toBe(
			false,
		);
		expect(DigestInputSchema.safeParse({ from: '19.10.2026', to: '2026-10-20' }).success).toBe(
			false,
		);
	});
});

describe('digestNotes', () => {
	it('keeps short notes, cuts long ones with an ellipsis, and drops empty ones', () => {
		expect(digestNotes('  Bring white shirt, shin pads & water ')).toBe(
			'Bring white shirt, shin pads & water',
		);
		const long = digestNotes('x'.repeat(DIGEST_NOTES_MAX + 50));
		expect(long).toHaveLength(DIGEST_NOTES_MAX + 1);
		expect(long?.endsWith('…')).toBe(true);
		expect(digestNotes('   ')).toBeUndefined();
		expect(digestNotes(null)).toBeUndefined();
	});
});

describe('digestForPeople', () => {
	it('keeps what is for the people asked about and what is for everyone', () => {
		expect(digestForPeople(['a'], undefined)).toBe(true);
		expect(digestForPeople(['a'], [])).toBe(true);
		expect(digestForPeople([], ['a'])).toBe(true);
		expect(digestForPeople(['a', 'b'], ['b'])).toBe(true);
		expect(digestForPeople(['a'], ['b'])).toBe(false);
	});
});

describe('rankDigest', () => {
	it('puts what meets the words first and keeps every item', () => {
		const items = [
			item('Swimming lesson', { notes: 'Leo is picked at the pool at 17:30' }),
			item('Dentist'),
			item('Pick-up from school'),
		];
		const ranked = rankDigest(items, ['pick up']);
		expect(ranked.map((i) => i.title)).toEqual([
			'Pick-up from school',
			'Swimming lesson',
			'Dentist',
		]);
		expect(ranked).toHaveLength(items.length);
	});

	it('keeps the order when no word meets an item', () => {
		const items = [item('Swimming lesson'), item('Dentist')];
		expect(rankDigest(items, ['pick up']).map((i) => i.title)).toEqual([
			'Swimming lesson',
			'Dentist',
		]);
		expect(rankDigest(items).map((i) => i.title)).toEqual(['Swimming lesson', 'Dentist']);
	});

	it('meets forms of a word and the extra facts', () => {
		expect(digestAboutScore(item('Swim training'), ['swimming'])).toBe(1);
		expect(digestAboutScore(item('Match', { extra: { location: 'Stadion' } }), ['stadion'])).toBe(
			1,
		);
		expect(digestAboutScore(item('Football'), ['ball'])).toBe(0);
	});
});

describe('digestOf', () => {
	it('cuts at the limit and says so', async () => {
		const items = Array.from({ length: 5 }, (_, i) => item(`Event ${i}`));
		const out = await digestOf(items, {}, { limit: 3 });
		expect(out.items).toHaveLength(3);
		expect(out.truncated).toBe(true);
		expect(DigestOutputSchema.parse(out)).toEqual(out);
	});

	it('cuts after ranking, so what the words meet stays in', async () => {
		const items = [...Array.from({ length: 5 }, (_, i) => item(`Event ${i}`)), item('Dentist')];
		const out = await digestOf(items, { about: ['dentist'] }, { limit: 2 });
		expect(out.items[0]?.title).toBe('Dentist');
	});

	it('asks for the next item only when the span is empty', async () => {
		let asked = 0;
		const next = async () => {
			asked++;
			return item('Date night', { date: '2026-10-24' });
		};
		expect(await digestOf([item('Dentist')], {}, { next })).toEqual({
			items: [item('Dentist')],
			truncated: false,
		});
		expect(asked).toBe(0);
		const empty = await digestOf([], {}, { next });
		expect(empty.nextAfter?.title).toBe('Date night');
		expect(asked).toBe(1);
		expect(await digestOf([], {}, { next: async () => null })).toEqual({
			items: [],
			truncated: false,
		});
	});

	it('counts what the AI may not see only when there is some', async () => {
		expect((await digestOf([], {}, { hidden: 2 })).hidden).toBe(2);
		expect('hidden' in (await digestOf([], {}, { hidden: 0 }))).toBe(false);
	});
});

describe('defineDigest', () => {
	it('is a read-only action with the digest shapes and the topic as its AI hint', () => {
		const digest = defineDigest({
			id: 'garage.digest',
			topic: 'vehicles',
			title: 'Garage',
			description: 'What the garage has',
			requires: 'garage.view',
			run: async (_uow, input) => digestOf([], input),
		});
		expect(digest.readOnly).toBe(true);
		expect(digest.approval).toBe('never');
		expect(digest.input).toBe(DigestInputSchema);
		expect(digest.output).toBe(DigestOutputSchema);
		expect(digest.ai).toEqual({ description: 'What the garage has', digest: 'vehicles' });
	});
});

describe('digest item href', () => {
	it('is a path inside the app, never an address elsewhere', () => {
		const parse = (href: string) =>
			DigestOutputSchema.safeParse({
				items: [item('Dentist', { href })],
				truncated: false,
			}).success;
		expect(parse('/calendar?event=event_1&on=2026-10-22')).toBe(true);
		expect(parse('/pets/pet_1')).toBe(true);
		expect(parse('https://example.com/x')).toBe(false);
		expect(parse('//example.com/x')).toBe(false);
		expect(parse('/a b')).toBe(false);
		expect(parse('/a\\b')).toBe(false);
	});

	it('is left out of what a model reads', () => {
		const output = {
			items: [item('Dentist', { href: '/calendar?event=x' })],
			nextAfter: item('Later', { href: '/calendar?event=y' }),
			truncated: false,
		};
		const read = JSON.stringify(readableOutput(output, createHandleTable()));
		expect(read).not.toContain('href');
		expect(read).not.toContain('/calendar');
		expect(read).toContain('Dentist');
		expect(withoutPaths({ a: [{ href: '/x', b: 1 }] })).toEqual({ a: [{ b: 1 }] });
	});
});
