import { QUESTION_TOPICS, type QuestionTopic } from '@famos/sdk';
import { type AssistantTool, areaOf } from './tools.ts';
import type { Intent } from './understand.ts';

/** What a change is about when the message names nothing: the three things people change most. */
export const CHANGE_FALLBACK_TOPICS: readonly QuestionTopic[] = ['calendar', 'tasks', 'shopping'];

/**
 * The topics a change or a thing to remember is about: those the message names, and those the
 * answer just before it was about (a card on the calendar, then "yes, move it"). With none, the
 * fallback.
 */
export function scopeTopics(
	named: readonly QuestionTopic[],
	earlier: readonly QuestionTopic[],
): QuestionTopic[] {
	const topics = [...new Set([...named, ...earlier])];
	return topics.length > 0 ? topics : [...CHANGE_FALLBACK_TOPICS];
}

/** The areas (extensions) that keep the topics, as the SDK maps them. */
export const areasOfTopics = (topics: readonly QuestionTopic[]): Set<string> =>
	new Set(topics.map((topic) => QUESTION_TOPICS[topic]));

/**
 * The tools a turn offers. A change or a thing to remember gets the draft tools and the read tools
 * of the areas it is about, a handful instead of every tool of the household: a model picks well
 * among a few. Core's reads (today's date, what waits for approval) always stay; its one draft
 * tool, the note to remember, only when the person asked to remember something. Anything else
 * ("any ideas for dinner?") keeps all tools.
 */
export function scopeTools(
	tools: readonly AssistantTool[],
	intent: Intent,
	topics: readonly QuestionTopic[],
): AssistantTool[] {
	if (intent !== 'change' && intent !== 'remember') return [...tools];
	const areas = areasOfTopics(topics);
	return tools.filter((tool) => {
		const area = areaOf(tool.actionId);
		if (area === 'core') return tool.kind === 'read' || intent === 'remember';
		return areas.has(area);
	});
}
