import type { Kernel } from '@famos/core';
import type { Actor, IndexedMention, Mention, MentionEnv, Resolution } from '@famos/sdk';

/** A mention of `kind`, as a model writes it in an answer. */
export function mention(kind: string, fields: Omit<Partial<Mention>, 'kind'> = {}): Mention {
	return { kind, ...fields };
}

/**
 * A model's answer to Quick add, for `k.llm.respond(...)`: the label, the intent (actionable
 * unless said), the mentions, and the sentences it read as written to the machine.
 */
export function understood(
	mentions: readonly Mention[] = [],
	options: {
		label?: string;
		intent?: 'actionable' | 'question' | 'nothing';
		addressed?: readonly string[];
	} = {},
): { label: string; intent: string; mentions: Mention[]; addressed?: string[] } {
	return {
		label: options.label ?? 'Shared item',
		intent: options.intent ?? (mentions.length > 0 ? 'actionable' : 'nothing'),
		mentions: [...mentions],
		...(options.addressed && { addressed: [...options.addressed] }),
	};
}

/** The AI as Quick add runs it: reading something shared, for nobody in particular. */
export const SHARE_AI: Actor = { kind: 'ai', mode: 'share', source: 'inbox' };

/**
 * Runs a kind's resolver the way the AI pipeline does (`resolveMentions` as the AI actor), for
 * an extension's resolver tests. Mentions without an index get their place in the list; the
 * reading has no text, sharer or records unless `env` gives them.
 */
export function resolveMentions(
	kernel: Pick<Kernel, 'ctx'>,
	kindId: string,
	mentions: readonly (Mention | IndexedMention)[],
	env: Partial<MentionEnv> = {},
	actor: Actor = SHARE_AI,
): Promise<Resolution[]> {
	const indexed = mentions.map((m, index) => ('mention' in m ? m : { index, mention: m }));
	return kernel.ctx.actions.resolveMentions(
		kindId,
		indexed,
		{ text: null, sharer: null, records: [], ...env },
		actor,
	);
}
