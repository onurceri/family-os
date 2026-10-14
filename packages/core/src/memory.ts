import { type Actor, defineAction, defineRoute, FamosError, idSchema } from '@famos/sdk';
import { z } from 'zod';
import { CORE_CAPABILITIES } from './core-capabilities.ts';
import type { CoreTables, MemberMemoryTable } from './tables.ts';

/**
 * Personal memory: short notes a member owns. The AI answering them in the app's conversation
 * may propose one as a draft only that member can approve, and sees the notes in that member's
 * own conversations and nowhere else. Nobody, admins included, reads another member's notes through any route or
 * action; texts are family content and are never logged.
 */

export const MEMORY_MAX_CHARS = 280;
/** More notes than this is a diary, not a memory. */
export const MEMORY_MAX_COUNT = 100;

const MemoryIdSchema = idSchema('memory');
const MemoryTextSchema = z.string().trim().min(1).max(MEMORY_MAX_CHARS);

export const MemorySchema = z.object({
	id: z.string(),
	text: z.string(),
	/** `ai`: the AI proposed it and the member approved it. */
	source: z.enum(['member', 'ai']),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type Memory = z.infer<typeof MemorySchema>;

const toMemory = (row: MemberMemoryTable): Memory => ({
	id: row.id,
	text: row.text,
	source: row.source,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
});

/**
 * The member whose memories a call may touch: a signed-in member, or the AI answering one in the
 * app's conversation (reading their notes for their own conversations). Never anyone else.
 */
function ownerOf(actor: Actor): string {
	if (actor.kind === 'member') return actor.memberId;
	if (actor.kind === 'ai' && actor.mode === 'conversation' && actor.onBehalfOf)
		return actor.onBehalfOf;
	throw new FamosError('forbidden', 'Memories belong to a member');
}

const memberOnly = (actor: Actor): string => {
	if (actor.kind !== 'member') throw new FamosError('forbidden', 'Only members can do this');
	return actor.memberId;
};

export function createMemory() {
	const addMemory = defineAction({
		id: 'core.addMemory',
		title: 'Remember something',
		draftTitle: 'app:draft_title_add_memory',
		input: z.object({
			text: MemoryTextSchema,
			/** Set by the AI when it proposed the note; a label, it grants nothing. */
			source: z.enum(['member', 'ai']).optional(),
		}),
		output: z.object({ id: z.string(), text: z.string() }),
		requires: CORE_CAPABILITIES.memoryUse.id,
		// Only the AI answering the person in the app proposes it, always as a draft only they decide.
		ai: {
			conversationOnly: true,
			addressToMember: true,
			description:
				'Suggests keeping a short note about this person (a preference, a fact, a routine) so you can use it in later conversations. Use only when the person says to remember something or states a lasting preference. One fact per note, at most 280 characters, written as a plain statement.',
			guidance: 'Never store secrets, passwords, health details or what other people told you.',
		},
		undo: (output) => ({ actionId: 'core.deleteMemory', input: { id: output.id } }),
		async run(uow, input) {
			const memberId = memberOnly(uow.actor);
			const db = uow.db.withTables<CoreTables>();
			const count = await db
				.selectFrom('core_member_memory')
				.select((eb) => eb.fn.countAll<number>().as('n'))
				.where('member_id', '=', memberId)
				.executeTakeFirstOrThrow();
			if (Number(count.n) >= MEMORY_MAX_COUNT)
				throw new FamosError('conflict', `At most ${MEMORY_MAX_COUNT} memories; delete one first`);
			const now = uow.clock.now();
			const id = uow.ids.next('memory');
			await db
				.insertInto('core_member_memory')
				.values({
					id,
					member_id: memberId,
					text: input.text,
					source: input.source ?? 'member',
					created_at: now,
					updated_at: now,
				})
				.execute();
			return { id, text: input.text };
		},
	});

	const updateMemory = defineAction({
		id: 'core.updateMemory',
		title: 'Change a memory',
		input: z.object({ id: MemoryIdSchema, text: MemoryTextSchema }),
		output: MemorySchema,
		requires: CORE_CAPABILITIES.memoryUse.id,
		approval: 'never',
		async run(uow, input) {
			const memberId = memberOnly(uow.actor);
			const db = uow.db.withTables<CoreTables>();
			const updated = await db
				.updateTable('core_member_memory')
				.set({ text: input.text, updated_at: uow.clock.now() })
				.where('id', '=', input.id)
				.where('member_id', '=', memberId)
				.returningAll()
				.executeTakeFirst();
			// Someone else's note is "not found", never "forbidden": it is not theirs to know about.
			if (!updated) throw new FamosError('not_found', 'Memory not found');
			return toMemory(updated);
		},
	});

	const deleteMemory = defineAction({
		id: 'core.deleteMemory',
		title: 'Forget a memory',
		input: z.object({ id: MemoryIdSchema }),
		output: z.object({ ok: z.literal(true) }),
		requires: CORE_CAPABILITIES.memoryUse.id,
		approval: 'never',
		async run(uow, input) {
			const memberId = memberOnly(uow.actor);
			const deleted = await uow.db
				.withTables<CoreTables>()
				.deleteFrom('core_member_memory')
				.where('id', '=', input.id)
				.where('member_id', '=', memberId)
				.executeTakeFirst();
			if (Number(deleted.numDeletedRows) === 0)
				throw new FamosError('not_found', 'Memory not found');
			return { ok: true as const };
		},
	});

	/**
	 * The notes for a prompt, newest first. Not offered to any model as a tool (no `ai` hints): the
	 * conversation's job reads them as the member it works for and puts them in that member's own
	 * conversations. Anyone else gets their own notes, never another member's.
	 */
	const recallMemories = defineAction({
		id: 'core.recallMemories',
		title: "Read the signed-in member's memories",
		input: z.object({ limit: z.number().int().min(1).max(MEMORY_MAX_COUNT).default(30) }),
		output: z.array(MemorySchema),
		readOnly: true,
		async run(uow, input) {
			const rows = await uow.db
				.withTables<CoreTables>()
				.selectFrom('core_member_memory')
				.selectAll()
				.where('member_id', '=', ownerOf(uow.actor))
				.orderBy('updated_at', 'desc')
				.orderBy('id', 'desc')
				.limit(input.limit)
				.execute();
			return rows.map(toMemory);
		},
	});

	const listMyMemories = defineRoute({
		method: 'get',
		path: '/memories',
		operationId: 'core.listMyMemories',
		summary: 'My own memories, newest first (nobody else can read them)',
		requires: CORE_CAPABILITIES.memoryUse.id,
		response: z.array(MemorySchema),
		async handle(ctx, { actor }) {
			const rows = await ctx.db
				.withTables<CoreTables>()
				.selectFrom('core_member_memory')
				.selectAll()
				.where('member_id', '=', memberOnly(actor))
				.orderBy('updated_at', 'desc')
				.orderBy('id', 'desc')
				.execute();
			return rows.map(toMemory);
		},
	});

	return {
		actions: [addMemory, updateMemory, deleteMemory, recallMemories],
		routes: [listMyMemories],
	};
}
