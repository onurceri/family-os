import { z } from 'zod';
import type { AiAreaAccess } from './llm.ts';
import { DayRefSchema, resolvePeople } from './understanding.ts';

/*
 * What a model reads from a question, and how code turns it into facts: the people the question
 * names, the topics it is about and the areas that can answer. The days are `resolveSpan` of
 * `@famos/time`. Nothing here knows a language: self-words come from the caller's catalog.
 */

/** The stretch of days a question is about, as the model reads it (`resolveSpan` makes days of it). */
export const SpanSchema = z.object({
	/** The words of the question that name the span, copied as written. */
	said: z.string().max(120),
	kind: z.enum(['day', 'week', 'weekend', 'month', 'next']).optional(),
	day: DayRefSchema.optional(),
	from: DayRefSchema.optional(),
	to: DayRefSchema.optional(),
});
export type Span = z.infer<typeof SpanSchema>;

/**
 * What a question can be about, and the area (extension) that keeps it. `core` always answers.
 * Shopping and tasks are both the lists extension; the digest of each is its own.
 */
export const QUESTION_TOPICS = {
	calendar: 'calendar',
	tasks: 'lists',
	shopping: 'lists',
	meals: 'kitchen',
	chores: 'chores',
	records: 'records',
	pets: 'pets',
	vehicles: 'vehicles',
	home: 'home',
	board: 'board',
	suggestions: 'core',
} as const;
export type QuestionTopic = keyof typeof QUESTION_TOPICS;
export const QUESTION_TOPIC_IDS = Object.keys(QUESTION_TOPICS) as [
	QuestionTopic,
	...QuestionTopic[],
];

/** What a question that names no topic is read as: the days of the span, and what is to do. */
export const FALLBACK_TOPICS: readonly QuestionTopic[] = ['calendar', 'tasks'];

export interface AskedMember {
	id: string;
	displayName: string;
}

/**
 * - `self`: a word for the asker ("me", "my");
 * - `everyone`: a word for the whole family;
 * - `member`: a name that one member's name shares whole words with;
 * - `ambiguous`: it shares words with several members and no one fits best;
 * - `none`: it names nobody in the family (a visitor, a pet, a school).
 */
export type AskedHow = 'self' | 'everyone' | 'member' | 'ambiguous' | 'none';

export interface AskedPerson {
	/** As the model copied it from the question. */
	said: string;
	how: AskedHow;
	/** The member, for `self` (the asker) and `member`. */
	memberId: string | null;
}

export interface AskedPeople {
	/** One entry per name said, in order. */
	people: AskedPerson[];
	/** The members meant, without repeats, in the order named. */
	ids: string[];
	/** True when a word for the whole family was said: no member filters the answer. */
	everyone: boolean;
	/** Names that matched nobody, or several members, to show as "not found" and not drop. */
	unmatched: string[];
}

const wordsOf = (text: string, locale: string) =>
	text
		.toLocaleLowerCase(locale)
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);

/**
 * The members a question names. A name matches whole words of a member's display name (so "Al"
 * is not Alex, and "Deniz’in" is Deniz), by the same rule Quick add uses (`resolvePeople`). A
 * phrase made only of the catalog's self-words ("me", "my") is the asker and one made only of its
 * words for everyone ("the whole family") is everyone; words are matched whole, never inside a
 * name. `selfWords` and `everyoneWords` are catalog strings (`ctx.vocabulary`), never code. A
 * self-word from someone unknown (no `asker`) is `none`.
 */
export function resolveAskedPeople(
	said: readonly string[],
	members: readonly AskedMember[],
	asker: string | null,
	selfWords: readonly string[],
	options: { everyoneWords?: readonly string[]; locale?: string } = {},
): AskedPeople {
	const locale = options.locale ?? 'en';
	const phrases = (list: readonly string[]) =>
		list.map((entry) => wordsOf(entry, locale).join(' ')).filter(Boolean);
	const selfSet = new Set(selfWords.flatMap((entry) => wordsOf(entry, locale)));
	const everyone = phrases(options.everyoneWords ?? []);
	const out: AskedPerson[] = [];
	const ids: string[] = [];
	const unmatched: string[] = [];
	let all = false;
	const add = (id: string | null) => {
		if (id !== null && !ids.includes(id)) ids.push(id);
	};
	for (const raw of said) {
		const name = raw.trim();
		const words = wordsOf(name, locale);
		if (words.length === 0) continue;
		if (everyone.includes(words.join(' '))) {
			all = true;
			out.push({ said: name, how: 'everyone', memberId: null });
			continue;
		}
		if (words.every((word) => selfSet.has(word))) {
			if (asker === null) {
				unmatched.push(name);
				out.push({ said: name, how: 'none', memberId: null });
			} else {
				add(asker);
				out.push({ said: name, how: 'self', memberId: asker });
			}
			continue;
		}
		const found = resolvePeople({ people: [name] }, { members, sharer: null, text: null, locale });
		const [only] = found.ids;
		if (only !== undefined && found.ids.length === 1) {
			add(only);
			out.push({ said: name, how: 'member', memberId: only });
			continue;
		}
		const shares = members.some((m) =>
			wordsOf(m.displayName, locale).some((w) => words.includes(w)),
		);
		unmatched.push(name);
		out.push({ said: name, how: shares ? 'ambiguous' : 'none', memberId: null });
	}
	return { people: out, ids, everyone: all, unmatched };
}

/** Why a topic cannot be answered here (the words of `AiMissingArea.why`). */
export type TopicMissingWhy = 'not_installed' | 'closed_to_ai';

export interface MissingTopic {
	topic: QuestionTopic;
	/** The extension that keeps it. */
	area: string;
	why: TopicMissingWhy;
}

export interface ResolvedTopics {
	/** The topics to fetch, without repeats, in the order named. */
	open: QuestionTopic[];
	/** The topics asked for that cannot be answered, so a "not here" line can say so. */
	missing: MissingTopic[];
	/** True when the question named no topic and `FALLBACK_TOPICS` stand in for it. */
	fallback: boolean;
}

/**
 * The topics a question can be answered for. A topic is open when its area is installed and the
 * AI may use it: access `any`, or `local` when the model runs on the family's own network
 * (`options.local`). `core` is always open. When nothing was named, the fallback topics are
 * asked for instead (and may themselves be missing).
 */
export function resolveTopics(
	topics: readonly QuestionTopic[],
	installed: ReadonlySet<string> | readonly string[],
	access: (area: string) => AiAreaAccess,
	options: { local?: boolean } = {},
): ResolvedTopics {
	const here = new Set(installed);
	const has = (area: string) => area === 'core' || here.has(area);
	const asked = [...new Set(topics)];
	const fallback = asked.length === 0;
	const open: QuestionTopic[] = [];
	const missing: MissingTopic[] = [];
	for (const topic of fallback ? FALLBACK_TOPICS : asked) {
		const area = QUESTION_TOPICS[topic];
		if (!has(area)) {
			missing.push({ topic, area, why: 'not_installed' });
			continue;
		}
		const level = area === 'core' ? 'any' : access(area);
		if (level === 'any' || (level === 'local' && options.local === true)) open.push(topic);
		else missing.push({ topic, area, why: 'closed_to_ai' });
	}
	return { open, missing, fallback };
}
