import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	DayRefSchema,
	findTarget,
	MENTION_LIMIT,
	MentionSchema,
	parseUnderstanding,
	REFUSAL_REASONS,
	resolvePeople,
	SLOTS,
	UnderstandingSchema,
} from '../src/index.ts';

const KINDS = ['calendar.event', 'calendar.eventCancel', 'lists.shoppingItem'];

describe('the understanding schema', () => {
	it('has a slot for every mention field but the bookkeeping ones and the link to another', () => {
		const fields = Object.keys(MentionSchema.shape).filter(
			(key) =>
				!['kind', 'forMe', 'peopleGuessed', 'timeText', 'unsure', 'quote', 'detailOf'].includes(
					key,
				),
		);
		expect(fields.toSorted()).toEqual([...SLOTS].toSorted());
	});

	it('takes a small answer as the model writes it', () => {
		const answer = {
			label: 'Football cancelled',
			intent: 'actionable',
			mentions: [
				{
					kind: 'calendar.eventCancel',
					target: 'Football',
					date: { text: 'Thursday', weekday: 4 },
				},
			],
		};
		expect(UnderstandingSchema.parse(answer)).toEqual(answer);
	});

	it('turns into a JSON Schema without unions', () => {
		const json = JSON.stringify(z.toJSONSchema(UnderstandingSchema));
		expect(json).not.toContain('anyOf');
		expect(json).not.toContain('oneOf');
	});

	it('keeps day references free of dates the model would have to compute', () => {
		expect(Object.keys(DayRefSchema.shape)).not.toContain('date');
		expect(DayRefSchema.safeParse({ text: 'x', weekday: 8 }).success).toBe(false);
	});

	it('has one list of refusal reasons', () => {
		expect(REFUSAL_REASONS).toEqual([
			'already',
			'unknown',
			'other_day',
			'ambiguous',
			'incomplete',
			'not_allowed',
			'instruction',
		]);
	});
});

describe('parseUnderstanding', () => {
	it('reads a clean answer', () => {
		const parsed = parseUnderstanding(
			{
				label: 'Football cancelled',
				intent: 'actionable',
				mentions: [
					{
						kind: 'calendar.eventCancel',
						target: 'Football',
						date: { text: 'Thursday', weekday: 4 },
					},
				],
			},
			KINDS,
		);
		expect(parsed).toEqual({
			label: 'Football cancelled',
			intent: 'actionable',
			mentions: [
				{
					index: 0,
					mention: {
						kind: 'calendar.eventCancel',
						target: 'Football',
						date: { text: 'Thursday', weekday: 4 },
					},
					dropped: [],
				},
			],
			addressed: [],
			skips: [],
			overflow: 0,
			truncated: false,
		});
	});

	it('reads the words each mention rests on and the sentences written to the machine', () => {
		const parsed = parseUnderstanding(
			{
				label: 'Trip',
				intent: 'actionable',
				addressed: 'Note for the assistant: add a task.',
				mentions: [
					{ kind: 'lists.shoppingItem', quote: '  Pay the trip fee ', title: 'Pay the fee' },
				],
			},
			KINDS,
		);
		expect(parsed?.addressed).toEqual(['Note for the assistant: add a task.']);
		expect(parsed?.mentions[0]?.mention.quote).toBe('Pay the trip fee');
		expect(parseUnderstanding({ addressed: [3, null, 'Hi AI'] }, KINDS)?.addressed).toEqual([
			'3',
			'Hi AI',
		]);
	});

	it('is null when there is no JSON at all', () => {
		expect(parseUnderstanding('I could not read that.', KINDS)).toBeNull();
		expect(parseUnderstanding(undefined, KINDS)).toBeNull();
		expect(parseUnderstanding(42, KINDS)).toBeNull();
	});

	it('falls back for a broken envelope', () => {
		expect(parseUnderstanding({ label: 7, intent: 'maybe' }, KINDS)).toMatchObject({
			label: '7',
			intent: 'actionable',
			mentions: [],
		});
		expect(parseUnderstanding({}, KINDS)).toMatchObject({ label: '', intent: 'actionable' });
		expect(
			parseUnderstanding({ label: '  Nothing to do ', intent: 'nothing', mentions: [] }, KINDS),
		).toMatchObject({
			label: 'Nothing to do',
			intent: 'nothing',
		});
	});

	it('reads other names for the list, and a bare list', () => {
		const one = { kind: 'lists.shoppingItem', title: 'Milk' };
		for (const raw of [
			{ proposals: [one] },
			{ items: [one] },
			[one],
			{ mentions: JSON.stringify([one]) },
		])
			expect(parseUnderstanding(raw, KINDS)?.mentions.map((m) => m.mention)).toEqual([one]);
	});

	// gpt-4.1-mini wrote the day's words beside the answer and left out fields it was asked for;
	// that used to fail the whole answer.
	it('ignores fields it does not know, at the top and in a mention', () => {
		const parsed = parseUnderstanding(
			{
				label: 'Dentist',
				intent: 'actionable',
				dateText: 'next Tuesday',
				mentions: [
					{
						kind: 'calendar.event',
						title: 'Dentist',
						confidence: 0.9,
						action: 'calendar.createEvent',
					},
				],
			},
			KINDS,
		);
		expect(parsed?.mentions).toEqual([
			{ index: 0, mention: { kind: 'calendar.event', title: 'Dentist' }, dropped: [] },
		]);
	});

	it("takes a mention's dateText as the words of its day", () => {
		const parsed = parseUnderstanding(
			{ mentions: [{ kind: 'calendar.event', title: 'Dentist', dateText: 'next Tuesday' }] },
			KINDS,
		);
		expect(parsed?.mentions[0]?.mention.date).toEqual({ text: 'next Tuesday' });
	});

	it('drops one bad field and keeps the mention', () => {
		const parsed = parseUnderstanding(
			{
				mentions: [
					{
						kind: 'calendar.event',
						title: 'Swim gala',
						people: { name: 'Ivy' },
						date: { text: 'Friday', weekday: 9, day: 16 },
						forMe: 'yes',
						place: 'Pool',
					},
				],
			},
			KINDS,
		);
		expect(parsed?.mentions[0]).toEqual({
			index: 0,
			mention: {
				kind: 'calendar.event',
				title: 'Swim gala',
				date: { text: 'Friday', day: 16 },
				place: 'Pool',
			},
			dropped: ['people', 'forMe', 'date'],
		});
	});

	it('reads which mention a detail belongs to, and drops a place that cannot be one', () => {
		const parsed = parseUnderstanding(
			{
				mentions: [
					{ kind: 'calendar.event', title: 'Piano recital' },
					{ kind: 'lists.shoppingItem', title: 'Blue music book', detailOf: '0' },
					{ kind: 'lists.shoppingItem', title: 'Water', detailOf: -1 },
				],
			},
			KINDS,
		);
		expect(parsed?.mentions[1]?.mention).toMatchObject({ detailOf: 0 });
		expect(parsed?.mentions[2]).toMatchObject({ dropped: ['detailOf'] });
		expect(parsed?.mentions[2]?.mention.detailOf).toBeUndefined();
	});

	it('repairs the usual slips', () => {
		const parsed = parseUnderstanding(
			{
				mentions: [
					{
						kind: ' calendar.event ',
						title: '  Piano recital  ',
						people: '["Ivy","Tom"]',
						tags: 'music',
						date: '20 October',
						endDate: '2026-10-21',
						time: '9:30',
						endTime: '16.45',
						notes: null,
						place: '',
						forMe: 'true',
						repeat: '{"every":"week","interval":"2"}',
					},
				],
			},
			KINDS,
		);
		expect(parsed?.mentions[0]).toEqual({
			index: 0,
			mention: {
				kind: 'calendar.event',
				title: 'Piano recital',
				people: ['Ivy', 'Tom'],
				tags: ['music'],
				date: { text: '20 October' },
				endDate: { text: '2026-10-21', numeric: '2026-10-21' },
				time: '09:30',
				endTime: '16:45',
				forMe: true,
				repeat: { every: 'week', interval: 2 },
			},
			dropped: [],
		});
	});

	it('cuts long text to the slot length instead of losing it', () => {
		const parsed = parseUnderstanding(
			{
				mentions: [
					{ kind: 'lists.shoppingItem', title: 'x'.repeat(250), tags: ['ok', 'y'.repeat(60)] },
				],
			},
			KINDS,
		);
		expect(parsed?.mentions[0]?.mention.title).toHaveLength(200);
		expect(parsed?.mentions[0]?.mention.tags).toEqual(['ok', 'y'.repeat(40)]);
	});

	it('reads times in words with the clock reader it is given, else drops them', () => {
		const raw = {
			mentions: [{ kind: 'calendar.event', title: 'Call', time: '4pm', timeText: '4pm' }],
		};
		expect(parseUnderstanding(raw, KINDS)?.mentions[0]).toEqual({
			index: 0,
			mention: { kind: 'calendar.event', title: 'Call', timeText: '4pm' },
			dropped: ['time'],
		});
		const clockTimes = (text: string) => (text === '4pm' ? ['16:00'] : []);
		expect(parseUnderstanding(raw, KINDS, { clockTimes })?.mentions[0]).toMatchObject({
			mention: { time: '16:00' },
			dropped: [],
		});
		expect(
			parseUnderstanding({ mentions: [{ kind: 'calendar.event', time: '25:00' }] }, KINDS)
				?.mentions[0]?.dropped,
		).toEqual(['time']);
	});

	it('drops a list item that cannot be used and says so', () => {
		const parsed = parseUnderstanding(
			{ mentions: [{ kind: 'calendar.event', people: ['Ivy', 42, { x: 1 }, null, ''] }] },
			KINDS,
		);
		expect(parsed?.mentions[0]).toMatchObject({
			mention: { people: ['Ivy', '42'] },
			dropped: ['people'],
		});
	});

	it('leaves out an empty day reference', () => {
		const parsed = parseUnderstanding(
			{ mentions: [{ kind: 'calendar.event', date: {}, endDate: { text: '  ' } }] },
			KINDS,
		);
		expect(parsed?.mentions[0]).toEqual({
			index: 0,
			mention: { kind: 'calendar.event' },
			dropped: [],
		});
	});

	it('keeps day parts without their words', () => {
		const parsed = parseUnderstanding(
			{ mentions: [{ kind: 'calendar.event', date: { inDays: '1' } }] },
			KINDS,
		);
		expect(parsed?.mentions[0]?.mention.date).toEqual({ text: '', inDays: 1 });
	});

	it('skips a kind that was not offered, naming what it was about', () => {
		const parsed = parseUnderstanding(
			{
				mentions: [
					{ kind: 'pets.treatment', title: 'Worming' },
					{ kind: 'calendar.event', title: 'Dentist' },
					{ target: 'Football' },
					'just text',
				],
			},
			KINDS,
		);
		expect(parsed?.skips).toEqual([
			{ index: 0, reason: 'incomplete', subject: 'Worming' },
			{ index: 2, reason: 'incomplete', subject: 'Football' },
			{ index: 3, reason: 'incomplete', subject: null },
		]);
		expect(parsed?.mentions.map((m) => m.index)).toEqual([1]);
	});

	it('keeps at most the first mentions and counts the rest', () => {
		const many = Array.from({ length: MENTION_LIMIT + 4 }, (_, i) => ({
			kind: 'lists.shoppingItem',
			title: `Item ${i}`,
		}));
		const parsed = parseUnderstanding({ mentions: many }, KINDS);
		expect(parsed?.mentions).toHaveLength(MENTION_LIMIT);
		expect(parsed?.overflow).toBe(4);
	});

	it('reads JSON in a text, in code fences or among prose', () => {
		const json =
			'{"label":"Milk","intent":"actionable","mentions":[{"kind":"lists.shoppingItem","title":"Milk"}]}';
		for (const text of [json, `\`\`\`json\n${json}\n\`\`\``, `Here you go:\n${json}\nDone.`])
			expect(parseUnderstanding(text, KINDS)).toMatchObject({
				label: 'Milk',
				mentions: [{ mention: { title: 'Milk' } }],
				truncated: false,
			});
	});

	// gemini-2.5-flash looped inside `tags` until the output cap cut the answer off.
	it('keeps the complete mentions of an answer that was cut off', () => {
		const loop = Array.from({ length: 300 }, () => '"Deniz\'in aşı randevusu"').join(',');
		const text = `{"label":"Vaccination","intent":"actionable","mentions":[{"kind":"lists.shoppingItem","title":"Plasters","tags":["{x}"]},{"kind":"calendar.event","title":"Vaccination","tags":["sağlık",${loop}`;
		expect(parseUnderstanding(text, KINDS)).toEqual({
			label: 'Vaccination',
			intent: 'actionable',
			mentions: [
				{
					index: 0,
					mention: { kind: 'lists.shoppingItem', title: 'Plasters', tags: ['{x}'] },
					dropped: [],
				},
			],
			addressed: [],
			skips: [],
			overflow: 0,
			truncated: true,
		});
	});

	it('is null for a cut-off text with no mentions in it', () => {
		expect(parseUnderstanding('{"label":"Vacc', KINDS)).toBeNull();
	});
});

const MEMBERS = [
	{ id: 'm_deniz', displayName: 'Deniz' },
	{ id: 'm_ivy', displayName: 'Ivy Moreau' },
	{ id: 'm_tom', displayName: 'Tom' },
	{ id: 'm_tomas', displayName: 'Tom Ash' },
	{ id: 'm_mara', displayName: 'Mara' },
];
const people = (
	mention: Parameters<typeof resolvePeople>[0],
	text: string | null,
	sharer: string | null = 'm_mara',
) => resolvePeople(mention, { members: MEMBERS, sharer, text, locale: 'en' });

describe('resolvePeople', () => {
	it('matches names by whole words of the display name', () => {
		expect(people({ people: ['Ivy'] }, 'Ivy has swimming')).toEqual({
			ids: ['m_ivy'],
			certain: true,
			unmatched: [],
		});
		expect(people({ people: ['ivy moreau'] }, 'Ivy has swimming').ids).toEqual(['m_ivy']);
	});

	it('reads a name with a possessive after an apostrophe', () => {
		expect(people({ people: ['Deniz’in'] }, 'Deniz’in aşı randevusu').ids).toEqual(['m_deniz']);
		expect(people({ people: ["Deniz'in"] }, "Deniz'in aşı randevusu").ids).toEqual(['m_deniz']);
	});

	it('takes the member the words spell completely when several share a word', () => {
		expect(people({ people: ['Tom'] }, 'Tom has football').ids).toEqual(['m_tom']);
		expect(people({ people: ['Tom Ash'] }, 'Tom Ash has football').ids).toEqual(['m_tomas']);
	});

	it('keeps names that are no member, for the title', () => {
		expect(people({ people: ['Ivy', 'Sam'] }, 'Ivy and Sam at the park')).toEqual({
			ids: ['m_ivy'],
			certain: true,
			unmatched: ['Sam'],
		});
	});

	it('is unsure of a member the text does not name', () => {
		expect(people({ people: ['Ivy'] }, 'The swimming lesson moved')).toEqual({
			ids: ['m_ivy'],
			certain: false,
			unmatched: [],
		});
	});

	it('cannot check names against files', () => {
		expect(people({ people: ['Ivy'] }, null).certain).toBe(true);
	});

	it('is unsure of people the model guessed', () => {
		expect(people({ people: ['Ivy'], peopleGuessed: true }, 'Ivy has swimming').certain).toBe(
			false,
		);
	});

	it('reads "for me" as the person who shared it', () => {
		expect(people({ forMe: true }, 'Remind me to call the bank')).toEqual({
			ids: ['m_mara'],
			certain: true,
			unmatched: [],
		});
		expect(people({ people: ['Mara'], forMe: true }, 'Mara: call the bank').ids).toEqual([
			'm_mara',
		]);
		expect(people({ forMe: true }, 'Remind me', null)).toEqual({
			ids: [],
			certain: false,
			unmatched: [],
		});
	});

	it('names each member once', () => {
		expect(people({ people: ['Ivy', 'Ivy Moreau'] }, 'Ivy Moreau').ids).toEqual(['m_ivy']);
	});

	// Names were not sent to the model, so it wrote the names as the message writes them; they are
	// matched here against the family's own list.
	it('matches the names a message writes when the family list was not sent', () => {
		expect(people({ people: ['Deniz’in'] }, 'Deniz’in dişçi randevusu salı')).toEqual({
			ids: ['m_deniz'],
			certain: true,
			unmatched: [],
		});
	});

	it('lower-cases names in the family language', () => {
		const deniz = (locale: string) =>
			resolvePeople(
				{ people: ['DENİZ'] },
				{ members: MEMBERS, sharer: null, text: 'DENİZ dentist Tuesday', locale },
			);
		expect(deniz('tr')).toEqual({ ids: ['m_deniz'], certain: true, unmatched: [] });
		expect(deniz('en').ids).toEqual([]);
	});

	it('finds nobody without people or members', () => {
		expect(people({}, 'Buy milk')).toEqual({ ids: [], certain: true, unmatched: [] });
		expect(
			resolvePeople({ people: ['Ivy'] }, { members: [], sharer: null, text: 'Ivy', locale: 'en' }),
		).toEqual({
			ids: [],
			certain: true,
			unmatched: ['Ivy'],
		});
	});
});

const item = (label: string) => ({ id: label.toLowerCase().replace(/\s+/g, '_'), label });

describe('findTarget', () => {
	const list = ['Bread', 'Oat milk', 'Milk', 'Picture hooks', 'Pay the swim course fee'].map(item);

	it('finds the label the words are', () => {
		expect(findTarget('milk', list)).toEqual({ found: item('Milk') });
		expect(findTarget('  BREAD ', list)).toEqual({ found: item('Bread') });
	});

	it('finds a label the words name', () => {
		expect(findTarget('the bread', list)).toEqual({ found: item('Bread') });
		expect(findTarget('the swim course fee', list)).toEqual({
			found: item('Pay the swim course fee'),
		});
	});

	it('asks rather than finds when most of a label is named but not all of it', () => {
		// "paid" is not "pay": a partial match is a question for the person, never a change.
		expect(findTarget('I paid the swim course fee', list)).toEqual({
			ambiguous: [item('Pay the swim course fee')],
			unsure: true,
		});
	});

	it('takes the one named most when the words name several', () => {
		expect(findTarget('the oat milk', list)).toEqual({ found: item('Oat milk') });
	});

	it('is none when only part of a label is named', () => {
		expect(findTarget('picture wire', list)).toEqual({ none: true });
		expect(findTarget('football', list)).toEqual({ none: true });
		expect(findTarget(undefined, list)).toEqual({ none: true });
		expect(findTarget('  ', list)).toEqual({ none: true });
		expect(findTarget('milk', [])).toEqual({ none: true });
	});

	it('is ambiguous when several fit equally', () => {
		const two = [
			{ id: 'a', label: 'Football' },
			{ id: 'b', label: 'Football' },
		];
		expect(findTarget('football', two)).toEqual({ ambiguous: two });
		const lessons = [
			{ id: 'a', label: 'Swim lesson Ivy' },
			{ id: 'b', label: 'Swim lesson Tom' },
		];
		expect(findTarget('swim lesson', lessons)).toEqual({ ambiguous: lessons });
	});

	it('lets the message pick among equal fits', () => {
		const lessons = [
			{ id: 'a', label: 'Swim lesson Ivy' },
			{ id: 'b', label: 'Swim lesson Tom' },
		];
		expect(findTarget('swim lesson', lessons, { text: "Tom's swim lesson is off" })).toEqual({
			found: lessons[1],
		});
	});

	it('is none when the message names something else more', () => {
		const tools = ['Picture hooks', 'Picture wire'].map(item);
		// The words were the model's, the message is the person's.
		expect(findTarget('picture hooks', tools, { text: 'Got the picture wire' })).toEqual({
			none: true,
		});
		expect(findTarget('picture hooks', tools, { text: 'Got the hooks' })).toEqual({
			found: item('Picture hooks'),
		});
		expect(findTarget('bread', list, { text: 'Bought everything' })).toEqual({ none: true });
	});

	it('reads labels in any language', () => {
		const lists = ['Ekmek', 'Süt'].map(item);
		expect(findTarget('süt', lists, { text: 'Sütü aldım, süt bitti' })).toEqual({
			found: item('Süt'),
		});
	});
});
