import { type Actor, AiContextSchema, isFamosError, type JobContext } from '@famos/sdk';

/** The most words of one list that reach the prompt. */
const MAX_WORDS = 50;

export interface Vocabulary {
	label: string;
	words: string[];
}

/**
 * The words the areas the assistant may suggest in already use, such as the family's calendar
 * tags: an area's plain AI context (`ai.context` whose items are words, not records). Read as the
 * AI working for the asking member, so an area closed to them or to the AI tells nothing. Without
 * them the model invents tags ("reminder") next to the ones the family has.
 */
export async function readVocabularies(
	ctx: Pick<JobContext, 'actions' | 'logger'>,
	actor: Actor,
	areas: ReadonlySet<string>,
): Promise<Vocabulary[]> {
	const out: Vocabulary[] = [];
	for (const [extensionId, actionIds] of ctx.actions.aiContextActions()) {
		if (!areas.has(extensionId)) continue;
		for (const actionId of actionIds) {
			try {
				const result = await ctx.actions.invoke(actionId, {}, actor);
				const parsed = AiContextSchema.safeParse(
					result.status === 'applied' ? result.output : null,
				);
				if (!parsed.success || !parsed.data.plain) continue;
				const words = parsed.data.items.map((item) => item.label).slice(0, MAX_WORDS);
				if (words.length > 0) out.push({ label: parsed.data.label, words });
			} catch (error) {
				// Locked, switched off or failing: the answer goes on without these words.
				if (!isFamosError(error)) ctx.logger.warn({ actionId }, 'assistant vocabulary failed');
			}
		}
	}
	return out;
}
