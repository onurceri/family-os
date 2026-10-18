import type { QuestionTopic } from '@famos/sdk';
import { todayIn } from '@famos/time';
import type { AnswerCard } from '../src/contract/index.ts';

/**
 * What one assistant case produced, and the checks that judge it. The checks look at what the
 * turn did (tool calls with their inputs, the drafts it left) and only loosely at the words of the
 * reply (contains or does not contain), since a good answer can be phrased many ways.
 */

/** A tool call the model made, with its input as the model sent it (handles, not ids). */
export interface Call {
	actionId: string;
	input: Record<string, unknown>;
}

/** A suggestion the turn left for a person to approve, with the input the host stored (ids). */
export interface Draft {
	actionId: string;
	input: Record<string, unknown>;
	/** The draft looks like something already there ("this may already be there"). */
	mayExist: boolean;
}

/** One fact the card of a question must show, read from the topic's digest as the asker. */
export interface Truth {
	topic: string;
	items: { title: string; date: string; standing: boolean }[];
}

/** One message of the conversation and what the assistant did with it. */
export interface Turn {
	ask: string;
	/**
	 * The stored answer as a chat outside the app shows it: the opening words, the answer card's
	 * lines and the host's "Suggested, not added yet:" lines under them.
	 */
	reply: string;
	/** `done`, or `failed` with the error code after a colon. */
	status: string;
	calls: Call[];
	drafts: Draft[];
	/** The answer card, when the message was answered as a question. */
	card?: AnswerCard | null;
	/** The model's opening words that were kept (empty when dropped or none). */
	lead?: string;
	/** What the card had to show, when the case says how its question should be read. */
	truth?: Truth[];
	/** Weekdays the reply put next to a date of another weekday (not the person's own). */
	weekdaySlips?: number;
}

/** What a question should be read as: its days, the topics it needs, and whom it is about. */
export interface Expected {
	from: string;
	to: string;
	/** Topics the card must answer (it may answer more). */
	topics: QuestionTopic[];
	/** Display names of the people asked about; none: everyone's. */
	people?: string[];
}

/** Ids of what the case seeded, by title or display name. */
export type Seeded = Record<string, string>;

export interface Outcome {
	turns: Turn[];
	seeded: Seeded;
	timeZone: string;
	/** The display name of the person asking. */
	asker?: string;
}

export interface Check {
	label: string;
	pass(outcome: Outcome): boolean;
}

type Input = Record<string, unknown>;

/** The last turn: most checks judge the answer to the last message. */
export const lastTurn = (o: Outcome): Turn =>
	o.turns.at(-1) ?? { ask: '', reply: '', status: 'missing', calls: [], drafts: [] };

/** Every draft the conversation left. */
export const allDrafts = (o: Outcome): Draft[] => o.turns.flatMap((t) => t.drafts);

const seededId = (o: Outcome, title: string) => {
	const id = o.seeded[title];
	if (!id) throw new Error(`The case seeded nothing called "${title}"`);
	return id;
};

/** Whether a draft's input names the seeded record (anywhere in it, by id). */
export const targets = (d: Draft, id: string) => JSON.stringify(d.input).includes(`"${id}"`);

/** A call of `actionId` whose input passes `match`. */
export function called(actionId: string, label: string, match: (i: Input) => boolean = () => true) {
	return {
		label: `called ${actionId}: ${label}`,
		pass: (o: Outcome) =>
			o.turns.some((t) => t.calls.some((c) => c.actionId === actionId && match(c.input))),
	} satisfies Check;
}

/** A draft of `actionId` in the last turn whose input passes `match`. */
export function drafted(
	actionId: string,
	label: string,
	match: (i: Input, o: Outcome, d: Draft) => boolean = () => true,
): Check {
	return {
		label: `drafted ${actionId}: ${label}`,
		pass: (o) => lastTurn(o).drafts.some((d) => d.actionId === actionId && match(d.input, o, d)),
	};
}

/** No draft at all in the whole conversation. */
export function noDrafts(): Check {
	return { label: 'no draft', pass: (o) => allDrafts(o).length === 0 };
}

/** No draft in the conversation that passes `match`. */
export function noDraft(label: string, match: (d: Draft, o: Outcome) => boolean): Check {
	return { label: `no draft ${label}`, pass: (o) => !allDrafts(o).some((d) => match(d, o)) };
}

/** At most `n` drafts in the conversation pass `match`. */
export function atMost(n: number, label: string, match: (d: Draft, o: Outcome) => boolean): Check {
	return {
		label: `at most ${n} draft(s) ${label}`,
		pass: (o) => allDrafts(o).filter((d) => match(d, o)).length <= n,
	};
}

/** The last answer matches every pattern. */
export function says(...patterns: RegExp[]): Check {
	return {
		label: `reply says ${patterns.join(' and ')}`,
		pass: (o) => patterns.every((p) => p.test(lastTurn(o).reply)),
	};
}

/** The last answer matches none of the patterns. */
export function neverSays(...patterns: RegExp[]): Check {
	return {
		label: `reply never says ${patterns.join(' or ')}`,
		pass: (o) => !patterns.some((p) => p.test(lastTurn(o).reply)),
	};
}

/** Either check passes. */
export function either(a: Check, b: Check): Check {
	return { label: `${a.label}, or ${b.label}`, pass: (o) => a.pass(o) || b.pass(o) };
}

/** Every turn was answered (no failure such as a step limit without an answer). */
export function answered(): Check {
	return { label: 'every turn answered', pass: (o) => o.turns.every((t) => t.status === 'done') };
}

/** A handle the host should have turned into a name (`cal_event:1`, `member:2`). */
const HANDLE = /\b[a-z][a-z_]*:\d+\b/;
/** An id with its entity prefix (`cal_event_0190…`, `shop_item_0190…`). */
const ID = /\b[a-z]+(?:_[a-z]+)*_[0-9a-f]{8}-[0-9a-f]{4}/;

/** No Markdown bold: the chat shows the text as it is. */
export function noBold(): Check {
	return {
		label: 'no ** in any reply',
		pass: (o) => o.turns.every((t) => !t.reply.includes('**')),
	};
}

/** No handle or id in any reply. */
export function noHandles(): Check {
	return {
		label: 'no handle or id in any reply',
		pass: (o) => o.turns.every((t) => !HANDLE.test(t.reply) && !ID.test(t.reply)),
	};
}

/**
 * Words that tell the person something was suggested, added or changed. Only false when nothing
 * was: the host adds its own "Suggested, not added yet:" line for real suggestions.
 */
const CLAIM =
	/\b(I(?:'ve| have)? (?:suggested|added|moved|changed|ticked|removed|created|scheduled|made a suggestion|put)|waiting for (?:your )?approval|needs? (?:to be )?approved|once (?:a person|someone|another person) approves)\b/i;

/** With no draft in the conversation, no answer claims a suggestion or a change. */
export function honest(): Check {
	return {
		label: 'no claim of a suggestion without a draft',
		// A card's words are the app's own, about suggestions that are really there.
		pass: (o) =>
			allDrafts(o).length > 0 || o.turns.every((t) => Boolean(t.card) || !CLAIM.test(t.reply)),
	};
}

/** Words written to the model about the person, which the person must never read. */
const ABOUT_THE_PERSON = /\b(tell the person|this person|the person (?:can|cannot|asking))\b/i;

/** No answer repeats words meant for the model ("…; tell the person."). */
export function speaksToThePerson(): Check {
	return {
		label: 'no words meant for the model in any reply',
		pass: (o) => o.turns.every((t) => !ABOUT_THE_PERSON.test(t.reply)),
	};
}

const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;

/** No date written as 2026-10-20 in any reply. */
export function noIsoDates(): Check {
	return {
		label: 'no ISO date in any reply',
		pass: (o) => o.turns.every((t) => !ISO_DATE.test(t.reply)),
	};
}

/** No weekday next to a date of another weekday in any reply, except the person's own. */
export function realWeekdays(): Check {
	return {
		label: 'no wrong weekday in any reply',
		pass: (o) => o.turns.every((t) => (t.weekdaySlips ?? 0) === 0),
	};
}

/** Checks every case gets: the formatting rules, honesty, and words for the person only. */
export const ALWAYS: readonly Check[] = [
	noBold(),
	noHandles(),
	honest(),
	speaksToThePerson(),
	noIsoDates(),
	realWeekdays(),
];

/** The last message was answered with a card made from the digests. */
export function answeredWithCard(): Check {
	return { label: 'answered as a question, with a card', pass: (o) => Boolean(lastTurn(o).card) };
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((x) => b.includes(x));

/**
 * The question was understood as the case says: the same days, the topics it needs among those
 * the card answers, and the same people. The share of cases that pass it is the eval's measure
 * of the model's reading.
 */
export function understood(expected: Expected): Check {
	const who = expected.people?.length ? expected.people.join(', ') : 'everyone';
	return {
		label: `understood: ${expected.topics.join('+')} · ${who} · ${expected.from}..${expected.to}`,
		pass: (o) => {
			const card = lastTurn(o).card;
			if (!card) return false;
			const u = card.understood;
			return (
				u.span.from === expected.from &&
				u.span.to === expected.to &&
				expected.topics.every((topic) => u.topics.includes(topic)) &&
				// "I" in "do I need to pick up Leo" may be read as the asker too: either is right.
				(sameSet(u.everyone ? [] : u.people, expected.people ?? []) ||
					sameSet(
						u.people.filter((name) => name !== o.asker),
						expected.people ?? [],
					))
			);
		},
	};
}

/** Every fact the digests hold for the days and people expected is on the card. */
export function complete(): Check {
	return {
		label: 'card: every fact of the days asked about is shown',
		pass: (o) => {
			const turn = lastTurn(o);
			if (!turn.card || !turn.truth) return false;
			return turn.truth.every((truth) => {
				const section = turn.card?.sections.find((s) => s.topic === truth.topic);
				return truth.items.every((item) =>
					section?.items.some(
						(shown) => shown.title === item.title && (item.standing || shown.date === item.date),
					),
				);
			});
		},
	};
}

/** Nothing outside the days asked about is shown as in them (what is late says so). */
export function inSpan(expected: Pick<Expected, 'from' | 'to'>): Check {
	return {
		label: 'card: nothing outside the days asked about is shown in them',
		pass: (o) => {
			const card = lastTurn(o).card;
			if (!card) return false;
			const { from, to } = card.understood.span;
			return card.sections.every((s) =>
				s.items.every(
					(i) =>
						i.status === 'overdue' ||
						i.kind === 'suggestion' ||
						i.date === undefined ||
						(i.date >= from && i.date <= to && i.date >= expected.from && i.date <= expected.to),
				),
			);
		},
	};
}

const NOTHING_WORDS = /\b(nothing|no events?|none)\b/i;

/** No "nothing" over a topic that has things: the card's own lines, and the opening words. */
export function noNothingOverItems(): Check {
	return {
		label: 'no "nothing" over a topic with things',
		pass: (o) => {
			const turn = lastTurn(o);
			if (!turn.card) return true;
			const full = turn.card.sections.filter((s) => s.items.length > 0);
			if (full.some((s) => s.next !== undefined)) return false;
			return !(
				turn.card.sections.length > 0 &&
				full.length === turn.card.sections.length &&
				NOTHING_WORDS.test(turn.lead ?? '')
			);
		},
	};
}

/** The opening words, when there are any, are at most this long. */
export function shortLead(sentences: number, words: number): Check {
	return {
		label: `opening words of at most ${sentences} sentence(s) and ${words} words`,
		pass: (o) => {
			const lead = lastTurn(o).lead ?? '';
			if (lead === '') return true;
			const count = lead.split(/(?<=[.!?…])\s+/u).filter((s) => s.trim() !== '').length;
			return count <= sentences && lead.split(/\s+/u).length <= words;
		},
	};
}

/** A read of `actionId` in any turn: a tool call of the loop, or a digest read for a card. */
export function looked(actionId: string, digestId: string): Check {
	return {
		label: `looked at ${actionId} or ${digestId}`,
		pass: (o) =>
			o.turns.some((t) => t.calls.some((c) => c.actionId === actionId || c.actionId === digestId)),
	};
}

/** The checks of a question the case says how to read. */
export const questionChecks = (expected: Expected): Check[] => [
	answeredWithCard(),
	understood(expected),
	complete(),
	inSpan(expected),
	noNothingOverItems(),
];

// Matchers for draft inputs.

/** The input's `id` is the seeded record called `title`. */
export const on = (title: string) => (i: Input, o: Outcome) => i.id === seededId(o, title);

/** A draft that targets the seeded record called `title`. */
export const about = (title: string) => (d: Draft, o: Outcome) => targets(d, seededId(o, title));

/**
 * The input's `occurrence` names `date` (YYYY-MM-DD in the family time zone): the date itself, or
 * the epoch-millisecond key the calendar lists.
 */
export function occurrenceOn(input: Input, date: string, timeZone: string): boolean {
	const occurrence = input.occurrence;
	if (typeof occurrence !== 'string' && typeof occurrence !== 'number') return false;
	const text = String(occurrence);
	if (text === date) return true;
	return /^\d{10,}$/.test(text) && todayIn(timeZone, Number(text)) === date;
}

/** The titles of a shopping draft's items. */
export const itemTitles = (i: Input): string[] =>
	((i.items as { title?: unknown }[] | undefined) ?? []).map((item) => String(item.title ?? ''));
