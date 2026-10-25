import {
	type Actor,
	type AnyActionDefinition,
	appOf,
	type DbExecutor,
	memberBehind,
	type NotifyRequest,
	type UnitOfWork,
} from '@famos/sdk';
import { DEFAULT_DRAFT_NOTIFY_DELAY_MS, draftWhat } from '../auto-approval.ts';
import { DECIDED_KIND, waitingDedupeKey } from '../draft-notices.ts';
import { familyReader } from '../family.ts';
import type { CoreTables, DraftRow } from '../tables.ts';
import type { Admission } from './admission.ts';
import type { Deciders } from './deciders.ts';
import type { Hints } from './hints.ts';
import type { ActionRunnerDeps } from './types.ts';

/** Who a notice names as the one who asked, the app a draft came through, and decided notices. */
export function createLabels(
	deps: ActionRunnerDeps,
	{
		coreDb,
		proposerOf,
		subjectOfDraft,
	}: Pick<Admission, 'coreDb'> & Pick<Deciders, 'proposerOf'> & Pick<Hints, 'subjectOfDraft'>,
) {
	/**
	 * Tells the person behind a draft what became of it, when somebody else decided it on its
	 * merits. Worked out before the decision's transaction (it reads outside it); null when nobody
	 * is to be told (their own decision, or a draft addressed to them alone).
	 */
	async function decidedNotice(
		draft: DraftRow,
		def: AnyActionDefinition,
		deciderId: string,
		outcome: 'approved' | 'rejected',
	): Promise<NotifyRequest | null> {
		const proposer = proposerOf(draft);
		if (proposer === null || proposer === deciderId || draft.for_member !== null) return null;
		const members = await familyReader(deps.db).members();
		const decider = members.find((m) => m.id === deciderId)?.displayName;
		if (!decider) return null;
		const subject = await subjectOfDraft(draft);
		const named = subject ? JSON.stringify({ label: subject }) : null;
		return {
			kind: DECIDED_KIND,
			to: { members: [proposer] },
			title: { key: `app:notify_draft_${outcome}_title`, params: { name: decider } },
			body: draftWhat({ summary: draft.summary, input: named }, def),
			url: '/add',
			source: { kind: draft.source_kind ?? 'draft', id: draft.source_id ?? draft.id },
			// The suggestions from one shared item decided together make one notice of each outcome.
			dedupeKey: `${outcome}:${waitingDedupeKey({ id: draft.id, sourceKind: draft.source_kind, sourceId: draft.source_id })}`,
			delayMs: deps.draftNotifyDelayMs ?? DEFAULT_DRAFT_NOTIFY_DELAY_MS,
		};
	}

	/**
	 * Who a notice names as the one who asked: the member, "Home Assistant" for an app on its own,
	 * or "Tom via Home Assistant" for an app acting for a member. Written in the family's language
	 * (the notice is stored once for every approver).
	 */
	async function proposerLabel(uow: UnitOfWork, actor: Actor): Promise<string | undefined> {
		const memberId = memberBehind(actor);
		const name =
			memberId === null
				? undefined
				: (await uow.family.members()).find((m) => m.id === memberId)?.displayName;
		const via = appOf(actor);
		if (!via) return name;
		const app = await uow.db
			.withTables<CoreTables>()
			.selectFrom('core_apps')
			.select('name')
			.where('id', '=', via.appId)
			.executeTakeFirst();
		if (!app) return name;
		if (!name) return app.name;
		const { locale } = await uow.family.settings();
		return deps.translate(locale, 'app:draft_via_app_member', { name, app: app.name });
	}

	/**
	 * The AI app an MCP caller works through, by its current name: the OAuth client's name for a
	 * sign-in, the key's own name for a personal key. Null when the source is not an app key or the
	 * key is gone.
	 */
	async function aiAppNamed(
		db: DbExecutor,
		source: { kind: string | null; id: string | null },
	): Promise<{ id: string; name: string } | null> {
		if (source.kind !== 'mcp' || !source.id) return null;
		const row = await db
			.withTables<CoreTables>()
			.selectFrom('core_api_tokens as k')
			.leftJoin('core_oauth_clients as c', 'c.id', 'k.oauth_client_id')
			.select(['k.id as id', 'k.name as keyName', 'c.name as clientName'])
			.where('k.id', '=', source.id)
			.executeTakeFirst();
		return row ? { id: row.id, name: row.clientName ?? row.keyName } : null;
	}

	/** "Ada via Claude" for an AI app working for a member; the member alone for any other AI. */
	async function aiProposerLabel(
		uow: UnitOfWork,
		memberId: string | null,
		source: { sourceKind?: string | null; sourceId?: string | null },
	): Promise<string | undefined> {
		const name =
			memberId === null
				? undefined
				: (await uow.family.members()).find((m) => m.id === memberId)?.displayName;
		const ai = await aiAppNamed(uow.db, {
			kind: source.sourceKind ?? null,
			id: source.sourceId ?? null,
		});
		if (!ai) return name;
		if (!name) return ai.name;
		const { locale } = await uow.family.settings();
		return deps.translate(locale, 'app:draft_via_app_member', { name, app: ai.name });
	}

	async function appBehind(draft: DraftRow) {
		const app = appOf(JSON.parse(draft.proposed_by) as Actor);
		if (!app) {
			const ai = await aiAppNamed(deps.db, { kind: draft.source_kind, id: draft.source_id });
			return ai ? { ...ai, kind: 'ai' as const } : null;
		}
		const row = await coreDb()
			.selectFrom('core_apps')
			.select(['id', 'name'])
			.where('id', '=', app.appId)
			.executeTakeFirst();
		return row ? { ...row, kind: 'connected' as const } : null;
	}

	return { decidedNotice, proposerLabel, aiAppNamed, aiProposerLabel, appBehind };
}

export type Labels = ReturnType<typeof createLabels>;
