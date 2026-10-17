import { describe, expect, it } from 'vitest';
import {
	defineExtension,
	defineMentionKind,
	type MentionKindDefinition,
	mentionKindProblems,
} from '../src/index.ts';

const kind = (extra: Partial<MentionKindDefinition> = {}): MentionKindDefinition =>
	defineMentionKind({
		id: 'pets.treatment',
		describe: 'A treatment a pet had or needs.',
		slots: {
			about: 'Which pet',
			date: 'When',
			time: 'At what time',
			people: 'Who takes the pet',
			variant: 'What kind of treatment',
		},
		variants: ['vaccine', 'checkup'],
		actions: ['pets.addTreatment'],
		examples: [
			{
				text: 'Rex had his vaccine yesterday',
				mentions: [
					{
						kind: 'pets.treatment',
						quote: 'Rex had his vaccine yesterday',
						about: 'Rex',
						variant: 'vaccine',
						date: { text: 'yesterday', inDays: -1 },
					},
				],
				why: 'Done, so the day is in the past.',
			},
		],
		resolve: async () => [],
		...extra,
	});

const problems = (k: MentionKindDefinition, siblings: MentionKindDefinition[] = [k]) =>
	mentionKindProblems('pets', k, siblings);

describe('a mention kind', () => {
	it('has no problem when well formed', () => {
		expect(problems(kind())).toEqual([]);
	});

	it('is named for its extension', () => {
		expect(problems(kind({ id: 'vehicles.treatment' }))[0]).toMatch(
			/must be namespaced as "pets.<name>"/,
		);
		expect(problems(kind({ id: 'pets.' }))[0]).toMatch(/must be namespaced/);
		expect(problems(kind({ id: 'pets.a.b' }))[0]).toMatch(/must be namespaced/);
	});

	it('describes itself and every slot it uses, and uses only known slots', () => {
		expect(problems(kind({ describe: ' ' }))).toContain(
			'Mention kind "pets.treatment" has no description',
		);
		expect(
			problems(kind({ slots: {}, variants: undefined, examples: [{ text: 'x', mentions: [] }] })),
		).toContain('Mention kind "pets.treatment" uses no slot');
		expect(problems(kind({ slots: { about: '', variant: 'v' } }))).toContain(
			'Mention kind "pets.treatment" does not describe slot "about"',
		);
		expect(
			problems(
				kind({
					slots: { about: 'x', colour: 'y', variant: 'v' } as MentionKindDefinition['slots'],
				}),
			),
		).toContain('Mention kind "pets.treatment" names unknown slot "colour"');
	});

	it('lists variants exactly when it uses the variant slot', () => {
		expect(problems(kind({ variants: undefined }))[0]).toMatch(
			/exactly when it uses the variant slot/,
		);
		expect(problems(kind({ variants: ['vaccine', 'vaccine'] }))[0]).toMatch(/repeated variants/);
		expect(problems(kind({ variants: [] }))[0]).toMatch(/no, empty or repeated variants/);
	});

	it('names at least one action, each once, and keeps its limit in bounds', () => {
		expect(problems(kind({ actions: [] }))).toContain(
			'Mention kind "pets.treatment" names no action',
		);
		expect(problems(kind({ actions: ['pets.a', 'pets.a'] }))).toContain(
			'Mention kind "pets.treatment" names an action twice',
		);
		expect(problems(kind({ limit: 0 }))[0]).toMatch(/limit outside 1 to 16/);
		expect(problems(kind({ limit: 17 }))[0]).toMatch(/limit outside/);
		expect(problems(kind({ limit: 1.5 }))[0]).toMatch(/limit outside/);
		expect(problems(kind({ limit: 2 }))).toEqual([]);
	});

	it('has examples that read as mentions of its extension, filling only slots their kind uses', () => {
		const example = (mention: object, text = 'Rex') =>
			kind({
				examples: [
					{
						text,
						mentions: [
							{ quote: 'Rex', ...mention } as MentionKindDefinition['examples'][0]['mentions'][0],
						],
					},
				],
			});
		expect(problems(kind({ examples: [] }))).toContain(
			'Mention kind "pets.treatment" has no example',
		);
		expect(problems(example({ kind: 'pets.treatment' }, ' '))[0]).toMatch(/example 1, has no text/);
		// A field the schema does not have, as a model might write it, is no example.
		expect(problems(example({ kind: 'pets.treatment', dateText: 'today' }))[0]).toMatch(
			/does not read as a mention/,
		);
		expect(
			problems(example({ kind: 'pets.treatment', date: { text: 'x', weekday: 9 } }))[0],
		).toMatch(/does not read as a mention: date.weekday/);
		expect(problems(example({ kind: 'calendar.event', title: 'Vet' }))[0]).toMatch(
			/names kind "calendar.event", which "pets" lacks/,
		);
		expect(problems(example({ kind: 'pets.treatment', place: 'Clinic' }))[0]).toMatch(
			/fills "place"/,
		);
		// Fields that belong to a slot count as that slot.
		expect(problems(example({ kind: 'pets.treatment', forMe: true, timeText: '9am' }))).toEqual([]);
		expect(problems(example({ kind: 'pets.treatment', unsure: ['place'] }))[0]).toMatch(
			/unsure of "place"/,
		);
		expect(problems(example({ kind: 'pets.treatment', variant: 'grooming' }))[0]).toMatch(
			/variant "grooming"/,
		);
		// Each shows the words of its text it rests on, as written.
		expect(problems(example({ kind: 'pets.treatment', quote: undefined }))[0]).toMatch(
			/has a mention without its quote/,
		);
		expect(problems(example({ kind: 'pets.treatment', quote: 'Max' }))[0]).toMatch(
			/quotes "Max", which its text does not write/,
		);
	});

	it('hands mentions only to kinds of other extensions', () => {
		expect(problems(kind({ handsOff: ['calendar.event'] }))).toEqual([]);
		expect(problems(kind({ handsOff: ['pets.other'] }))[0]).toMatch(
			/hands mentions to "pets.other", which is no kind of another extension/,
		);
		expect(problems(kind({ handsOff: ['calendar'] }))[0]).toMatch(/hands mentions to "calendar"/);
	});

	it('may show its extension’s other kinds in an example, by their own slots', () => {
		const done = kind({
			id: 'pets.treatmentDone',
			slots: { target: 'Which treatment' },
			variants: undefined,
			examples: [
				{
					text: 'Rex got his vaccine; book the next one',
					mentions: [
						{ kind: 'pets.treatmentDone', quote: 'Rex got his vaccine', target: 'vaccine' },
						{
							kind: 'pets.treatment',
							quote: 'book the next one',
							about: 'Rex',
							variant: 'vaccine',
						},
					],
				},
			],
		});
		expect(problems(done, [done, kind()])).toEqual([]);
		expect(problems(done, [done])[0]).toMatch(/names kind "pets.treatment", which "pets" lacks/);
	});

	it('is owned by the extension that declares it', () => {
		const manifest = { id: 'vehicles', version: '1.0.0', sdk: '^0.7.0' };
		expect(() => defineExtension({ manifest, ai: { kinds: [kind()] } })).toThrow(
			'Mention kind "pets.treatment" must be namespaced as "vehicles.…"',
		);
	});
});
