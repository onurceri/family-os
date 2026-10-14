import {
	type Actor,
	type ConversationAnswer,
	type ConversationAsked,
	type DbExecutor,
	type ExtensionContext,
	FamosError,
	type MemberId,
	type UploadedFile,
	type UploadSpec,
} from '@famos/sdk';
import type { Access } from './access.ts';
import type { Features } from './features.ts';
import type { Registry } from './registry.ts';
import type { CoreTables } from './tables.ts';

/** Whether a MIME type is one of `accept` (`image/*` style wildcards allowed). */
export function mimeAccepted(type: string, accept: readonly string[]): boolean {
	const t = type.toLowerCase();
	return accept.some((a) =>
		a.endsWith('/*') ? t.startsWith(a.slice(0, -1)) : t === a.toLowerCase(),
	);
}

/** What a channel outside the app (Telegram, email) received from a member. */
export interface ChannelShare {
	channel: string;
	title?: string;
	text?: string;
	url?: string;
	files: { name: string; type: string; bytes: Uint8Array }[];
}

const asUploaded = (file: { name: string; type: string; bytes: Uint8Array }): UploadedFile => ({
	field: 'files',
	name: file.name,
	type: file.type,
	size: file.bytes.length,
	stream: async function* () {
		yield file.bytes;
	},
	bytes: async () => file.bytes,
});

/**
 * The doors channels outside the app use: they reach the share target and the conversation the
 * installed extensions provide without knowing which extensions those are. Each door does what
 * the HTTP layer does for a request (the member must be active and hold the provider's
 * capability, the provider must be turned on), so a channel can never do more than the app.
 */
export function createHostDoors(deps: {
	db: DbExecutor;
	registry: Registry;
	access: Access;
	features: Features;
	ctx: () => ExtensionContext;
}) {
	const { registry, access, features } = deps;

	/** The member as an actor, or null when they are archived or unknown. */
	async function memberActor(memberId: string): Promise<Actor | null> {
		const row = await deps.db
			.withTables<CoreTables>()
			.selectFrom('core_members')
			.select(['id', 'role_id'])
			.where('id', '=', memberId)
			.where('archived_at', 'is', null)
			.executeTakeFirst();
		return row ? { kind: 'member', memberId: row.id as MemberId, roleId: row.role_id } : null;
	}

	/** The member, if they may use a provider that needs `requires`; throws otherwise. */
	async function allowed(memberId: string, requires: string, what: string): Promise<Actor> {
		const actor = await memberActor(memberId);
		if (!actor) throw new FamosError('forbidden', 'Not a member');
		if (!access.can(actor, requires)) throw new FamosError('forbidden', `Not allowed to ${what}`);
		return actor;
	}

	return {
		memberActor,

		/** What one share may carry, or null when nothing receives shares. */
		shareLimits(): UploadSpec | null {
			return registry.shareTarget?.target.limits ?? null;
		},

		/**
		 * Hands what a member sent to the share target as that member. Throws a `FamosError`:
		 * `feature_off` when nothing receives shares or the receiver is off, `forbidden` for a
		 * member who may not share, `bad_request` for files beyond the limits.
		 */
		async share(memberId: string, share: ChannelShare): Promise<void> {
			const found = registry.shareTarget;
			if (!found || !features.isOn(found.extension))
				throw new FamosError('feature_off', 'Nothing receives shares');
			const { target } = found;
			const actor = await allowed(memberId, target.requires, 'share');
			const { files } = share;
			const total = files.reduce((sum, f) => sum + f.bytes.length, 0);
			if (
				files.length > target.limits.maxFiles ||
				total > target.limits.maxBytes ||
				files.some((f) => !mimeAccepted(f.type, target.limits.accept))
			)
				throw new FamosError('bad_request', 'This file cannot be added');
			await target.receive(deps.ctx(), actor, {
				channel: share.channel,
				...(share.title !== undefined && { title: share.title }),
				...(share.text !== undefined && { text: share.text }),
				...(share.url !== undefined && { url: share.url }),
				files: files.map(asUploaded),
			});
		},

		conversation: {
			/**
			 * Asks the conversation as the member. Throws a `FamosError`: `feature_off` when there is
			 * no conversation or it is off, `forbidden` for a member who may not ask, and whatever the
			 * provider refuses with (`conflict` while the last answer is being written).
			 */
			async ask(
				memberId: string,
				question: { text: string; threadId: string | null },
			): Promise<ConversationAsked> {
				const found = registry.conversation;
				if (!found || !features.isOn(found.extension))
					throw new FamosError('feature_off', 'No conversation to ask');
				const actor = await allowed(memberId, found.provider.requires, 'ask');
				return found.provider.ask(deps.ctx(), actor, question);
			},

			/** The member's finished answer `replyId`, or null (not theirs, not written, none). */
			async answer(memberId: string, replyId: string): Promise<ConversationAnswer | null> {
				const found = registry.conversation;
				if (!found || !features.isOn(found.extension)) return null;
				return found.provider.answer(deps.ctx(), memberId, replyId);
			},
		},
	};
}

export type HostDoors = ReturnType<typeof createHostDoors>;
