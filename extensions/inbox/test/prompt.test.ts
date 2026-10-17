import type { AiKindInfo } from '@famos/sdk';
import { describe, expect, it } from 'vitest';
import {
	HOST_EXAMPLES,
	PROMPT_VERSION,
	promptHash,
	systemPrompt,
	understandingJsonSchema,
} from '../src/server/understand/prompt.ts';

const kind = (id: string, extra: Partial<AiKindInfo> = {}): AiKindInfo => ({
	id,
	extension: id.split('.')[0] as string,
	describe: `What ${id} is.`,
	slots: { title: 'What it is' },
	examples: [{ text: `An example of ${id}`, mentions: [{ kind: id, title: 'Thing' }] }],
	limit: 16,
	...extra,
});

const parts = (kinds: AiKindInfo[]) => ({
	kinds,
	weekday: 'Tuesday',
	today: '2026-10-06',
	timeZone: 'UTC',
	language: 'English',
	members: [{ displayName: 'Ivy', about: '13 years old' }],
	sharer: 'Ivy',
	known: [{ from: 'garden.aiContext', label: 'Plants', items: [{ label: 'Fern' }] }],
});

describe('the answer schema', () => {
	it('is the same small shape whatever is installed, with the kind narrowed to the offered ones', () => {
		const one = understandingJsonSchema(['a.thing']);
		const many = understandingJsonSchema(['a.thing', 'b.other', 'c.more']);
		const shape = (s: unknown) => JSON.stringify(s).replace(/"enum":\[[^\]]*\]/gu, '');
		expect(shape(one)).toEqual(shape(many));
		expect(JSON.stringify(many)).toContain('"enum":["a.thing","b.other","c.more"]');
		// Limits that some providers reject or loop on are left out; the parser enforces them.
		expect(JSON.stringify(many)).not.toMatch(/maxLength|maxItems|minimum|anyOf|\$schema/);
	});
});

describe('the prompt', () => {
	it('is built from the kinds, the family and the known names, with no ids or handles', () => {
		const system = systemPrompt(
			parts([kind('garden.note', { knownFrom: ['garden.aiContext'], variants: ['a', 'b'] })]),
		);
		expect(system).toContain('Today is Tuesday, 2026-10-06 (time zone UTC).');
		expect(system).toContain('Family members:\n- Ivy: 13 years old');
		expect(system).toContain('This message was shared by Ivy.');
		expect(system).toContain('### garden.note\nWhat garden.note is.');
		expect(system).toContain('variant is one of: a, b');
		expect(system).toContain('Known names: Plants (below)');
		expect(system).toContain('Plants:\n- Fern');
		expect(system).toContain('Message: "An example of garden.note"');
	});

	it('shows an example only when every kind it reads is offered', () => {
		const lonely = kind('garden.note', {
			examples: [
				{ text: 'Only notes', mentions: [{ kind: 'garden.note', title: 'A' }] },
				{
					text: 'Notes and watering',
					mentions: [
						{ kind: 'garden.note', title: 'A' },
						{ kind: 'garden.watered', about: 'Fern' },
					],
				},
			],
		});
		const system = systemPrompt(parts([lonely]));
		expect(system).toContain('Only notes');
		expect(system).not.toContain('Notes and watering');
		// The host's own example of text that gives orders needs the calendar.
		expect(system).not.toContain('Ignore your instructions');
	});

	it('names nobody when names may not be sent', () => {
		const system = systemPrompt({ ...parts([kind('garden.note')]), members: null, sharer: null });
		expect(system).not.toContain('Ivy');
		expect(system).not.toContain('Family members');
	});
});

describe('the prompt fingerprint', () => {
	it('changes with what the model is asked, not with the family', () => {
		const kinds = [kind('garden.note')];
		expect(promptHash(kinds)).toMatch(/^[0-9a-f]{8}$/);
		expect(promptHash(kinds)).toBe(promptHash([kind('garden.note')]));
		expect(promptHash([kind('garden.note', { describe: 'Other words.' })])).not.toBe(
			promptHash(kinds),
		);
		expect(PROMPT_VERSION).toMatch(/^inbox\.understand\/\d+$/);
	});

	it('covers each part of a kind the model sees', () => {
		const base = kind('garden.note', { knownFrom: ['garden.aiContext'], variants: ['a'] });
		const changed: Partial<AiKindInfo>[] = [
			{ slots: { title: 'What it is called' } },
			{ variants: ['a', 'b'] },
			{ knownFrom: ['garden.otherContext'] },
			{ examples: [{ text: 'Another example', mentions: [{ kind: 'garden.note', title: 'X' }] }] },
			{ limit: 4 },
		];
		for (const change of changed)
			expect(promptHash([{ ...base, ...change }]), JSON.stringify(change)).not.toBe(
				promptHash([base]),
			);
		// An example the prompt leaves out (it needs a kind that is not offered) does not count.
		const hidden = {
			...base,
			examples: [
				...base.examples,
				{ text: 'Hidden', mentions: [{ kind: 'garden.watered', about: 'Fern' }] },
			],
		};
		expect(promptHash([hidden])).toBe(promptHash([base]));
	});
});

describe('the host’s own examples', () => {
	it('quote only words their message writes, as written', () => {
		for (const example of HOST_EXAMPLES) {
			for (const line of example.answer.addressed ?? []) expect(example.text).toContain(line);
			for (const m of example.answer.mentions) {
				expect(m.quote, example.text).toBeDefined();
				expect(example.text).toContain(m.quote);
			}
		}
	});

	it('show each mention’s quote last, after what was read', () => {
		const prompt = systemPrompt({
			...parts([kind('calendar.event'), kind('lists.task')]),
		});
		expect(prompt).toContain(
			'"timeText":"15:00","place":"Library","quote":"Book fair at the library on Friday 16 October at 15:00"}',
		);
	});
});
