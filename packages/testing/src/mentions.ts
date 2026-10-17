import type { Kernel } from '@famos/core';
import type { Actor, IndexedMention, Mention, MentionEnv, Resolution } from '@famos/sdk';

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
