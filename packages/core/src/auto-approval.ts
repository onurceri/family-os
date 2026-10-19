import {
	type Actor,
	type DbExecutor,
	defineAction,
	defineJob,
	defineNotificationKind,
	defineRoute,
	FamosError,
	isFamosError,
	type JobContext,
	memberBehind,
	type NotifyRequest,
	type NotifyText,
	personPresent,
	subjectOf,
} from '@famos/sdk';
import { z } from 'zod';
import type { Access } from './access.ts';
import { CORE_CAPABILITIES } from './core-capabilities.ts';
import { WAITING_KIND, waitingDedupeKey } from './draft-notices.ts';
import type { Registry } from './registry.ts';
import type { CoreTables } from './tables.ts';

/**
 * Auto-approval: a manager chooses, per action that opted in, that drafts the AI
 * proposed for people who hold a capability are approved at once, as the manager who turned it on. The action
 * runner enqueues `core.autoApprove` when such a draft is created; the job re-checks everything
 * and approves through the runner, so the enabling member's capabilities apply at that moment.
 */

const KEY = 'core.autoApproval';
const JOB = 'core.autoApprove';
/** Drafts proposed within this time of each other (one shared item) make one notification. */
export const DEFAULT_DRAFT_NOTIFY_DELAY_MS = 30_000;

/** The enabling member is told when the setting stops applying on its own. */
export const autoApprovalStopped = defineNotificationKind({
	id: 'core.autoApprovalStopped',
	label: 'app:notify_kind_auto_approval_stopped',
	audience: CORE_CAPABILITIES.autoApproveManage.id,
});

export const AutoApprovalSettingSchema = z.object({
	/** Drafts the AI proposed for a person who holds this capability (the assistant, the Inbox) are approved. */
	proposerCapability: z.string().min(1).max(100),
});

const StoredEntrySchema = AutoApprovalSettingSchema.extend({
	enabledBy: z.string(),
	enabledAt: z.number(),
});
export type StoredAutoApproval = z.infer<typeof StoredEntrySchema>;
const StoredSchema = z.record(z.string(), StoredEntrySchema);

export async function readAutoApproval(
	db: DbExecutor,
): Promise<Record<string, StoredAutoApproval>> {
	const row = await db
		.withTables<CoreTables>()
		.selectFrom('core_settings')
		.select('value')
		.where('key', '=', KEY)
		.executeTakeFirst();
	if (!row) return {};
	try {
		const parsed = StoredSchema.safeParse(JSON.parse(row.value));
		return parsed.success ? parsed.data : {};
	} catch {
		return {};
	}
}

async function writeAutoApproval(
	db: DbExecutor,
	settings: Record<string, StoredAutoApproval>,
	now: number,
) {
	const value = JSON.stringify(settings);
	await db
		.withTables<CoreTables>()
		.insertInto('core_settings')
		.values({ key: KEY, value, updated_at: now })
		.onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: now }))
		.execute();
}

/** What decides whether a draft is approved by the setting. */
export interface DraftFacts {
	proposerKind: Actor['kind'];
	/** The person behind it: who proposed it, or who the assistant or the Inbox item is for. */
	proposerMemberId: string | null;
	/** Addressed to one member alone: theirs to decide. */
	addressedTo: string | null;
}

/** The facts about a draft from the actor that proposed it. */
export function factsOf(
	actor: Actor,
	forMember: string | null | undefined,
	addressedTo: string | null,
): DraftFacts {
	return {
		proposerKind: actor.kind,
		proposerMemberId: memberBehind(actor) ?? (actor.kind === 'ai' ? (forMember ?? null) : null),
		addressedTo,
	};
}

/**
 * Whether the setting covers this draft: only what the AI proposed for a person who holds the
 * capability (read from shared messages, or by the assistant). Drafts a person made themselves,
 * of the system or displays, and personal drafts never qualify.
 */
export async function qualifies(
	db: DbExecutor,
	access: Access,
	setting: Pick<StoredAutoApproval, 'proposerCapability'>,
	facts: DraftFacts,
): Promise<boolean> {
	if (facts.addressedTo !== null || facts.proposerKind !== 'ai') return false;
	if (facts.proposerMemberId === null) return false;
	const proposer = await db
		.withTables<CoreTables>()
		.selectFrom('core_members')
		.select(['role_id', 'archived_at'])
		.where('id', '=', facts.proposerMemberId)
		.executeTakeFirst();
	if (!proposer || proposer.archived_at !== null) return false;
	return access.effective(proposer.role_id).has(setting.proposerCapability);
}

/**
 * What a suggestion proposes, in each reader's language: the proposer's own words (the summary),
 * else the action's translated name (the English `title` only if an action has no key) with the
 * name of the thing it is about ("Remove a shopping item: Cheddar"). With `who`, the person who
 * asked comes first ("Leo: Change an event: Piano lesson").
 */
export function draftWhat(
	draft: { summary: string | null; input?: string | null },
	action: { title: string; draftTitle?: string },
	who?: string,
): NotifyText {
	const name = draft.input ? subjectOf(draft.input) : undefined;
	const by = who ? '_by' : '';
	const asker: Record<string, string> = who ? { who } : {};
	if (draft.summary === null && action.draftTitle) {
		if (name)
			return {
				key: `app:notify_draft_waiting_named${by}`,
				params: { what: action.draftTitle, name, ...asker },
			};
		return who
			? { key: 'app:notify_draft_waiting_action_by', params: { what: action.draftTitle, who } }
			: { key: action.draftTitle };
	}
	const what = draft.summary ?? (name ? `${action.title}: ${name}` : action.title);
	return { key: `app:notify_draft_waiting_body${by}`, params: { what, ...asker } };
}

/** Tells approvers a suggestion waits for them (collapses several drafts of one source). */
export function waitingNotice(
	draft: {
		id: string;
		summary: string | null;
		sourceKind: string | null;
		sourceId: string | null;
		/** The draft's input as stored (JSON): names the thing the notice is about. */
		input?: string | null;
	},
	action: { title: string; draftTitle?: string },
	except: string | null,
	delayMs: number,
	/** The name of the person who asked, when a person is behind it. */
	who?: string,
): NotifyRequest {
	const sourceKind = draft.sourceKind ?? 'draft';
	return {
		kind: WAITING_KIND,
		to: { capability: 'core.drafts.approve', ...(except && { except }) },
		title: { key: 'app:notify_draft_waiting_title' },
		body: draftWhat(draft, action, who),
		url: '/add',
		source: { kind: sourceKind, id: draft.sourceId ?? draft.id },
		dedupeKey: waitingDedupeKey(draft),
		delayMs,
	};
}

export const AUTO_APPROVE_JOB = JOB;

/** The part of the action runner the job needs (the runner itself imports this module). */
export interface DraftApprover {
	approveDraft(
		draftId: string,
		approver: Actor,
		editedInput?: unknown,
		options?: { auto?: boolean },
	): Promise<unknown>;
}

export interface AutoApprovalDeps {
	runner: () => DraftApprover;
	access: () => Access;
	registry: () => Registry;
	/** How long a suggestion waits before it notifies approvers. */
	draftNotifyDelayMs: number;
}

const SettingViewSchema = AutoApprovalSettingSchema.extend({
	enabledBy: z.string(),
	enabledByName: z.string().nullable(),
	enabledAt: z.number(),
});

const ActionViewSchema = z.object({
	actionId: z.string(),
	/** i18n key naming what is approved ("Shopping items"). */
	labelKey: z.string(),
	/** The capabilities a proposer may be required to hold; the first is the default. */
	choices: z.array(z.object({ value: z.string(), labelKey: z.string() })),
	/** Null while the action's drafts wait for a person. */
	setting: SettingViewSchema.nullable(),
});

export function createAutoApproval(deps: AutoApprovalDeps) {
	const { runner, access, registry } = deps;
	const tables = (db: DbExecutor) => db.withTables<CoreTables>();

	const setAutoApproval = defineAction({
		id: 'core.setAutoApproval',
		title: 'Turn auto-approval on or off for an action',
		description:
			'Drafts the AI proposed for people who hold the capability are approved at once, as the person who turns this on. Null turns it off.',
		input: z.object({
			actionId: z.string().min(1).max(100),
			setting: AutoApprovalSettingSchema.nullable(),
		}),
		output: z.object({ ok: z.literal(true) }),
		requires: CORE_CAPABILITIES.autoApproveManage.id,
		approval: 'never',
		async run(uow, input) {
			if (!personPresent(uow.actor)) throw new FamosError('forbidden', 'Only members can do this');
			const def = registry().actions.get(input.actionId);
			if (!def?.autoApprove)
				throw new FamosError('bad_request', `"${input.actionId}" cannot be auto-approved`);
			const settings = await readAutoApproval(uow.db);
			if (input.setting === null) {
				delete settings[input.actionId];
			} else {
				if (!def.autoApprove.capabilities.includes(input.setting.proposerCapability))
					throw new FamosError(
						'bad_request',
						`"${input.setting.proposerCapability}" is not a choice for "${input.actionId}"`,
					);
				settings[input.actionId] = {
					...input.setting,
					enabledBy: uow.actor.memberId,
					enabledAt: uow.clock.now(),
				};
			}
			await writeAutoApproval(uow.db, settings, uow.clock.now());
			return { ok: true as const };
		},
	});

	const listAutoApproval = defineRoute({
		method: 'get',
		path: '/auto-approval',
		operationId: 'core.listAutoApproval',
		summary: 'Actions that may be auto-approved, with their setting',
		requires: CORE_CAPABILITIES.autoApproveManage.id,
		response: z.object({ actions: z.array(ActionViewSchema) }),
		async handle(ctx) {
			const settings = await readAutoApproval(ctx.db);
			const views: z.infer<typeof ActionViewSchema>[] = [];
			for (const def of registry().actions.values()) {
				if (!def.autoApprove) continue;
				const choices = def.autoApprove.capabilities.flatMap((value) => {
					const capability = access().capability(value);
					return capability ? [{ value, labelKey: capability.label }] : [];
				});
				if (choices.length === 0) continue;
				const stored = settings[def.id];
				let setting: z.infer<typeof SettingViewSchema> | null = null;
				if (stored) {
					const member = await tables(ctx.db)
						.selectFrom('core_members')
						.select('display_name')
						.where('id', '=', stored.enabledBy)
						.executeTakeFirst();
					setting = { ...stored, enabledByName: member?.display_name ?? null };
				}
				views.push({ actionId: def.id, labelKey: def.autoApprove.label, choices, setting });
			}
			return { actions: views.sort((a, b) => a.actionId.localeCompare(b.actionId)) };
		},
	});

	/** Stops the setting and tells whoever can act on it; safe to repeat. */
	async function stop(
		ctx: JobContext,
		actionId: string,
		setting: StoredAutoApproval,
		reason: 'gone' | 'lost_access' | 'cannot',
	) {
		const title = registry().actions.get(actionId)?.title ?? actionId;
		await ctx.notify({
			kind: autoApprovalStopped.id,
			// The one who turned it on hears first; when they are gone, whoever manages it does.
			to:
				reason === 'gone'
					? { capability: CORE_CAPABILITIES.autoApproveManage.id }
					: { members: [setting.enabledBy] },
			title: { key: 'app:notify_auto_approval_stopped_title', params: { what: title } },
			body: { key: `app:notify_auto_approval_stopped_${reason}`, params: { what: title } },
			url: '/settings/auto-approval',
			source: { kind: 'auto-approval', id: actionId },
			dedupeKey: `auto-approval-stopped:${actionId}:${setting.enabledAt}`,
		});
		await ctx.db.transaction().execute(async (trx) => {
			const settings = await readAutoApproval(trx);
			// Not a newer setting someone made meanwhile.
			if (settings[actionId]?.enabledAt !== setting.enabledAt) return;
			delete settings[actionId];
			await writeAutoApproval(trx, settings, ctx.clock.now());
		});
	}

	const approveJob = defineJob({
		name: JOB,
		payload: z.object({
			draftId: z.string(),
			/** The person behind the draft, resolved when it was made (the Inbox does not store it). */
			proposerMemberId: z.string(),
		}),
		maxAttempts: 3,
		async handle(ctx, { draftId, proposerMemberId }) {
			const draft = await tables(ctx.db)
				.selectFrom('core_drafts')
				.selectAll()
				.where('id', '=', draftId)
				.executeTakeFirst();
			// Decided by a person meanwhile, or already done by an earlier run: nothing to do.
			if (draft?.status !== 'pending') return;
			const def = registry().actions.get(draft.action_id);
			const proposedBy = JSON.parse(draft.proposed_by) as Actor;
			const who = (await ctx.family.members()).find((m) => m.id === proposerMemberId)?.displayName;
			const waiting = () =>
				ctx.notify(
					waitingNotice(
						{
							id: draft.id,
							summary: draft.summary,
							sourceKind: draft.source_kind,
							sourceId: draft.source_id,
							input: draft.edited_input ?? draft.input,
						},
						def ?? { title: draft.action_id },
						proposerMemberId,
						deps.draftNotifyDelayMs,
						who,
					),
				);

			const setting = (await readAutoApproval(ctx.db))[draft.action_id];
			const facts: DraftFacts = {
				proposerKind: proposedBy.kind,
				proposerMemberId,
				addressedTo: draft.for_member,
			};
			if (!setting || !def?.autoApprove || !(await qualifies(ctx.db, access(), setting, facts)))
				return waiting();

			const enabler = await tables(ctx.db)
				.selectFrom('core_members')
				.select(['id', 'role_id', 'archived_at'])
				.where('id', '=', setting.enabledBy)
				.executeTakeFirst();
			if (!enabler || enabler.archived_at !== null) {
				await stop(ctx, draft.action_id, setting, 'gone');
				return waiting();
			}
			if (!access().effective(enabler.role_id).has(CORE_CAPABILITIES.autoApproveManage.id)) {
				await stop(ctx, draft.action_id, setting, 'lost_access');
				return waiting();
			}
			try {
				await runner().approveDraft(
					draft.id,
					{ kind: 'member', memberId: enabler.id as never, roleId: enabler.role_id },
					undefined,
					{ auto: true },
				);
			} catch (error) {
				if (!isFamosError(error)) throw error;
				if (error.code === 'forbidden') {
					await stop(ctx, draft.action_id, setting, 'cannot');
					return waiting();
				}
				// Decided meanwhile, gone, or applying failed (it then waits in the Inbox as failed).
				if (error.code === 'unavailable') return waiting();
				if (error.code !== 'conflict' && error.code !== 'not_found') throw error;
			}
		},
	});

	return {
		actions: [setAutoApproval],
		routes: [listAutoApproval],
		jobs: [approveJob],
		notifications: [autoApprovalStopped],
	};
}
