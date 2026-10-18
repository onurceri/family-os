import { describe, expect, it } from 'vitest';
import {
	compareThing,
	findTarget,
	labelNamesTitle,
	type MatchBand,
	matchThing,
	targetOf,
	whichOne,
} from '../src/index.ts';

const thing = (label: string, id = label.toLowerCase().replace(/\s+/gu, '_')) => ({ id, label });

describe('compareThing', () => {
	it('is exact for the same words and codes, whatever their order, case and accents', () => {
		expect(compareThing('Oat milk', 'oat MILK')).toEqual({ band: 'exact', reason: 'same' });
		expect(compareThing('training football', 'Football training')).toEqual({
			band: 'exact',
			reason: 'same',
		});
		expect(compareThing('Sut', 'Süt', { language: 'de' }).band).toBe('exact');
		// In the family's language: in Turkish, ü and ı are letters of their own.
		expect(compareThing('Sut', 'Süt', { language: 'tr' }).band).toBe('none');
		expect(compareThing('TOPLANTI', 'toplantı', { language: 'tr' }).band).toBe('exact');
		expect(compareThing('CAFE visit', 'Café visit', { language: 'en' }).band).toBe('exact');
		expect(compareThing('Class 1B trip', 'class 1b TRIP').band).toBe('exact');
		expect(compareThing('4', ' 4 ').band).toBe('exact');
	});

	it('is strong when one side holds all the words of the other', () => {
		expect(compareThing('Milk', 'Oat milk')).toEqual({ band: 'strong', reason: 'within' });
		expect(compareThing('the bread', 'Bread').band).toBe('strong');
		expect(compareThing('Class trip to Bled', 'Class 1B trip to Bled').band).toBe('strong');
	});

	it('is weak for other forms of the words and for most of the words', () => {
		expect(compareThing('Dentist checkups', 'Dentist checkup')).toEqual({
			band: 'weak',
			reason: 'forms',
		});
		expect(compareThing('Swim lesson Tom', 'Swim lesson Ivy')).toEqual({
			band: 'weak',
			reason: 'partial',
		});
	});

	it('is none for other words, a part of a word, or a long other form', () => {
		expect(compareThing('Dental cleaning', 'Dentist checkup').band).toBe('none');
		expect(compareThing('dent', 'Dentist checkup').band).toBe('none');
		expect(compareThing('Swim', 'Swimming gala').band).toBe('none');
		expect(compareThing('4', 'Oat milk').band).toBe('none');
		expect(compareThing('  ', 'Oat milk').band).toBe('none');
	});

	it('tells codes, numbers and plates apart', () => {
		expect(compareThing('Class 3B trip to Bled', 'Class 1B trip to Bled')).toEqual({
			band: 'none',
			reason: 'codes',
		});
		expect(compareThing('8.B trip to bled on thu 29.10', 'Class 1B trip to Bled').band).toBe(
			'none',
		);
		expect(compareThing('Pay 18 EUR', 'Pay 10 EUR for the bus').band).toBe('none');
		expect(compareThing('Match u-13', 'Match U15').band).toBe('none');
		expect(compareThing('MOT 34 ABC 123', 'MOT 34 ABC 124').band).toBe('none');
	});

	it('reads one code written in different ways', () => {
		expect(compareThing('Class 8.B trip', 'Class 8b trip to Bled').band).toBe('strong');
		expect(compareThing('Match u-13 (Sat 24.10)', 'Match U13').band).toBe('exact');
		expect(compareThing('MOT 34ABC123', 'MOT 34 ABC 123').band).toBe('exact');
		expect(
			compareThing('Yüzme 3.A sınıfı', 'Yüzme 3a sınıfı gezisi', { language: 'tr' }).band,
		).toBe('strong');
	});
});

describe('matchThing', () => {
	it('takes the best band, then the thing the words name most', () => {
		const list = ['Bread', 'Oat milk', 'Milk'].map((l) => thing(l));
		expect(matchThing('milk', list)).toMatchObject({ band: 'exact', candidate: thing('Milk') });
		expect(matchThing('the oat milk', list)).toMatchObject({
			band: 'strong',
			candidate: thing('Oat milk'),
		});
	});

	it('is weak with every candidate when several fit as well, and never picks one', () => {
		const two = [thing('Football', 'a'), thing('Football', 'b')];
		expect(matchThing('football', two)).toMatchObject({
			band: 'weak',
			reason: 'several',
			candidates: two,
		});
	});

	it('is weak for a partial match, listing what it may be', () => {
		const lessons = [thing('Swim lesson Ivy'), thing('Piano lesson')];
		expect(matchThing('swim lesson Tom', lessons)).toMatchObject({
			band: 'weak',
			reason: 'partial',
			candidate: thing('Swim lesson Ivy'),
		});
	});

	it('says when only a code kept a thing out', () => {
		expect(matchThing('Class 3B trip', [thing('Class 1B trip')])).toMatchObject({
			band: 'none',
			reason: 'codes',
		});
	});

	it('holds the choice to the message', () => {
		const tools = [thing('Picture hooks'), thing('Picture wire')];
		expect(matchThing('picture hooks', tools, { text: 'Got the picture wire' })).toMatchObject({
			band: 'none',
			reason: 'elsewhere',
		});
		const lessons = [thing('Swim lesson Ivy'), thing('Swim lesson Tom')];
		expect(matchThing('swim lesson', lessons, { text: "Tom's swim lesson is off" })).toMatchObject({
			band: 'strong',
			candidate: thing('Swim lesson Tom'),
		});
	});
});

describe('a code names its thing', () => {
	const game = thing('U13 Eagles away game');
	const others = ['Football training', 'Swim lesson Ivy', 'Class 1B trip'].map((l) => thing(l));

	it('is weak by the same code of letters and digits with other words, and marked when alone', () => {
		expect(compareThing('U13 fixture', game.label)).toEqual({ band: 'weak', reason: 'code' });
		const match = matchThing('fixture for U13', [game, ...others]);
		expect(match).toMatchObject({ band: 'weak', reason: 'code', candidate: game });
		expect(targetOf(match)).toBe('marked');
		expect(findTarget('U13 fixture', [game, ...others])).toEqual({ found: game, unsure: true });
	});

	it('is no match by a bare number, and asks which one when two share the code', () => {
		expect(compareThing('Dentist 10', 'Swim 10').band).toBe('none');
		const training = thing('U13 training');
		const found = findTarget('U13 fixture', [game, training]);
		expect(found).toMatchObject({ unsure: true });
		expect(
			'ambiguous' in found && [...found.ambiguous].toSorted((a, b) => a.id.localeCompare(b.id)),
		).toEqual([game, training]);
	});

	it('holds when the message also names something else by a word the thing lacks', () => {
		const text =
			"Dear parents, the fixture for U13 on Saturday 24.10 is moved to 11:00 at Stadion Bežigrad (was 10:00 at Olimpija). Ivy's team kit bag to the club room.";
		expect(matchThing('U13 Eagles away game', [game, ...others], { text })).toMatchObject({
			band: 'exact',
			candidate: game,
		});
		expect(matchThing('U13 fixture', [game, ...others], { text })).toMatchObject({
			band: 'weak',
			reason: 'code',
			candidate: game,
		});
	});
});

describe('findTarget on matchThing', () => {
	it('finds exact and strong matches as sure', () => {
		const list = [thing('Dentist checkup')];
		expect(findTarget('dentist checkup', list)).toEqual({ found: thing('Dentist checkup') });
		expect(findTarget('dental cleaning', list)).toEqual({ none: true });
	});

	it('finds the one thing named by other forms of its words, marked unsure', () => {
		const list = [thing('Dentist checkup'), thing('Piano lesson')];
		expect(findTarget('dentist checkups', list)).toEqual({
			found: thing('Dentist checkup'),
			unsure: true,
		});
	});

	it('asks which one when other forms of the words fit two things, even on a day', () => {
		const lessons = [thing('Swim lesson Ivy'), thing('Swim lesson Tom')];
		expect(findTarget('swim lessons', lessons)).toEqual({ ambiguous: lessons, unsure: true });
	});

	it('finds nothing when a code differs, however close the words', () => {
		expect(findTarget('Class 3B trips', [thing('Class 1B trip')])).toEqual({ none: true });
		expect(findTarget('Class 3B trip', [thing('Class 1B trip')])).toEqual({ none: true });
	});

	it('keeps several equally good names apart from guesses', () => {
		const two = [thing('Football', 'a'), thing('Football', 'b')];
		expect(findTarget('football', two)).toEqual({ ambiguous: two });
	});
});

describe('targetOf', () => {
	it('acts on sure matches and on a lone match by other forms, marked', () => {
		expect(targetOf({ band: 'strong', reason: 'within', candidates: [1] })).toBe('sure');
		expect(targetOf({ band: 'weak', reason: 'forms', candidates: [1] })).toBe('marked');
		expect(targetOf({ band: 'weak', reason: 'partial', candidates: [1] })).toBeNull();
		expect(targetOf({ band: 'weak', reason: 'several', candidates: [1, 2] })).toBeNull();
		expect(targetOf({ band: 'none', reason: 'codes', candidates: [] })).toBeNull();
	});
});

describe('labelNamesTitle, kept for packages built against it', () => {
	it('is namesThing', () => {
		expect(labelNamesTitle('Milk', 'Oat milk')).toBe(true);
		expect(labelNamesTitle('Class 3B trip', 'Class 1B trip')).toBe(false);
	});
});

describe('whichOne', () => {
	it('names the words and the things they may mean', () => {
		expect(whichOne('football', [thing('Football training'), thing('Football match')])).toBe(
			'football (Football training, Football match)',
		);
		expect(
			whichOne(
				'x',
				['A', 'B', 'C', 'D', 'A'].map((l) => thing(l)),
			),
		).toBe('x (A, B, C, …)');
		expect(whichOne('x', [])).toBe('x');
	});
});

/*
 * Properties over generated tables: words of several scripts, codes, and the ways a person or a
 * model writes the same thing differently. A fixed seed keeps every run the same.
 */

function random(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const WORDS = [
	'football',
	'training',
	'dentist',
	'checkup',
	'school',
	'trip',
	'bled',
	'piano',
	'recital',
	'parents',
	'evening',
	'yüzme',
	'sınıfı',
	'gezisi',
	'öğretmen',
	'toplantı',
	'veli',
	'müze',
	'ekmek',
	'çarşı',
	'garage',
	'service',
	'insurance',
	'renewal',
];
/**
 * The words a family of that language writes. A dotless ı has no upper case of its own outside
 * Turkish ("TOPLANTI" lower-cases to "toplanti" in English), so it is cased only in Turkish.
 */
const wordsFor = (language: string) =>
	language === 'tr' ? WORDS : WORDS.filter((w) => !/[ıİ]/u.test(w));
const CODES = ['1b', '3b', '10', '18', 'u13', 'u15', '2024', '7a', '34abc123', '12'];
const LANGUAGES = ['en', 'tr', 'de'] as const;
const CASES = 200;

function pick<T>(next: () => number, items: readonly T[], count: number): T[] {
	const pool = [...items];
	const out: T[] = [];
	while (out.length < count && pool.length > 0)
		out.push(pool.splice(Math.floor(next() * pool.length), 1)[0] as T);
	return out;
}

function shuffled<T>(next: () => number, items: readonly T[]): T[] {
	return pick(next, items, items.length);
}

/** One of the ways a word may be cased: as is, upper, lower, or a capital first letter. */
function recase(next: () => number, word: string, language: string): string {
	const way = Math.floor(next() * 4);
	if (way === 1) return word.toLocaleUpperCase(language);
	if (way === 2) return word.toLocaleLowerCase(language);
	if (way === 3) return word.charAt(0).toLocaleUpperCase(language) + word.slice(1);
	return word;
}

const written = (next: () => number, parts: readonly string[], language: string) =>
	shuffled(next, parts)
		.map((p) => recase(next, p, language))
		.join(' ');

const ACTED: readonly MatchBand[] = ['exact', 'strong'];

describe('matchThing properties', () => {
	it('never gives strong or exact when the codes disagree', () => {
		const next = random(1);
		for (let n = 0; n < CASES; n++) {
			const language = LANGUAGES[n % LANGUAGES.length] as string;
			const shared = pick(next, wordsFor(language), 1 + Math.floor(next() * 3));
			const extra = pick(
				next,
				wordsFor(language).filter((w) => !shared.includes(w)),
				Math.floor(next() * 2),
			);
			const [a, b] = pick(next, CODES, 2) as [string, string];
			const words = [...shared, a].join(' ');
			const title = [...shared, ...extra, b].join(' ');
			const { band } = compareThing(words, title, { language });
			expect(ACTED, `${words} / ${title}`).not.toContain(band);
			expect(ACTED).not.toContain(compareThing(title, words, { language }).band);
			expect(ACTED).not.toContain(matchThing(words, [thing(title)], { language }).band);
		}
	});

	it('gives the same answer whatever the order and the case of the words', () => {
		const next = random(2);
		for (let n = 0; n < CASES; n++) {
			const language = LANGUAGES[n % LANGUAGES.length] as string;
			const parts = [...pick(next, wordsFor(language), 1 + Math.floor(next() * 3))];
			if (next() < 0.4) parts.push(...pick(next, CODES, 1));
			const others = [...pick(next, wordsFor(language), 1 + Math.floor(next() * 3))];
			if (next() < 0.4) others.push(...pick(next, CODES, 1));
			const words = parts.join(' ');
			const title = others.join(' ');
			const first = compareThing(words, title, { language });
			const again = compareThing(written(next, parts, language), written(next, others, language), {
				language,
			});
			expect(again, `${words} / ${title}`).toEqual(first);

			const candidates = [thing(title, 'a'), thing(parts.slice(0, 1).join(' '), 'b')];
			const chosen = matchThing(words, candidates, { language });
			const reordered = matchThing(written(next, parts, language), shuffled(next, candidates), {
				language,
			});
			expect(reordered.band, `${words} / ${candidates.map((c) => c.label).join(' | ')}`).toBe(
				chosen.band,
			);
			expect(reordered.reason).toBe(chosen.reason);
			if (chosen.band !== 'weak') expect(reordered.candidate?.id).toBe(chosen.candidate?.id);
			else
				expect(new Set(reordered.candidates.map((c) => c.id))).toEqual(
					new Set(chosen.candidates.map((c) => c.id)),
				);
		}
	});

	it('gives a title that holds more than the words strong at most, never exact', () => {
		const next = random(3);
		for (let n = 0; n < CASES; n++) {
			const language = LANGUAGES[n % LANGUAGES.length] as string;
			const words = pick(next, wordsFor(language), 1 + Math.floor(next() * 3));
			const more = pick(
				next,
				wordsFor(language).filter((w) => !words.includes(w)),
				1 + Math.floor(next() * 2),
			);
			if (next() < 0.3) more.push(...pick(next, CODES, 1));
			const title = written(next, [...words, ...more], language);
			const said = written(next, words, language);
			expect(compareThing(said, title, { language }).band, `${said} / ${title}`).toBe('strong');
			expect(matchThing(said, [thing(title)], { language }).band).toBe('strong');
		}
	});
});
