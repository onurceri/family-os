import {
	type Actor,
	type AnyActionDefinition,
	type DigestItem,
	defineAction,
	defineDigest,
	digestOf,
	memberBehind,
	subjectOf,
	type UnitOfWork,
} from '@famos/sdk';
import { dateLocale, formatDate, todayIn, zoned } from '@famos/time';
import { z } from 'zod';
import { draftDateOf, WAITING_STATUSES } from '../draft-expiry.ts';
import { ownerOf } from '../features.ts';
import { readStoredInput } from '../stored-input.ts';
import type { CoreTables, DraftRow } from '../tables.ts';
import type { CoreExtensionDeps } from './deps.ts';
import { type DRAFT_STATUSES, draftReason } from './drafts.ts';
import { members } from './member-rows.ts';

/** How many of the newest drafts `core.mySuggestions` looks through to find the member's own. */
const MY_SUGGESTIONS_WINDOW = 300;

/** How many waiting suggestions the suggestions digest names, newest first. */
const SUGGESTIONS_DIGEST_LIMIT = 15;

const SUGGESTION_STATUS = {
	pending: 'waiting',
	failed: 'failed',
	approved: 'approved',
	applied: 'approved',
	rejected: 'rejected',
	undone: 'undone',
	expired: 'expired',
} as const satisfies Record<(typeof DRAFT_STATUSES)[number], string>;

/** The action's title and, when the input has one, its name or text: "Add shopping item: Milk". */
function suggestionLabel(
	title: string | undefined,
	row: DraftRow,
	subject: string | undefined = subjectOf(row.edited_input ?? row.input),
	scope?: string,
): string {
	const what = subject;
	const base = title ?? row.action_id;
	const label = what ? `${base}: ${what}` : base;
	return scope ? `${label} (${scope})` : label;
}

/** What became of a person's suggestions, and which wait for them, for an agent to answer with. */
export function createSuggestions(deps: CoreExtensionDeps) {
	/**
	 * What a draft is about, by name. A draft stored before drafts carried the real title of what
	 * they change names its target only by id: the action says what that is called now, read from
	 * its own extension's tables through this transaction.
	 */
	const draftSubject = async (uow: UnitOfWork, row: DraftRow) => {
		const raw = row.edited_input ?? row.input;
		const named = subjectOf(raw);
		const def = deps.registry().actions.get(row.action_id);
		const look = def?.targetTitle ?? def?.subject;
		if (named || !def || !look) return named;
		try {
			const input = def.input.safeParse(readStoredInput(def, raw));
			const ctx = {
				db: deps.extensionDb(ownerOf(def.id), uow.db),
				family: uow.family,
				translate: uow.translate,
				vocabulary: uow.vocabulary,
				now: uow.clock.now(),
			};
			return input.success ? ((await look(ctx, input.data)) ?? undefined)?.slice(0, 80) : undefined;
		} catch {
			return undefined;
		}
	};

	/**
	 * What became of suggestions, so an agent answers "was it approved?" instead of guessing. An
	 * agent working in a conversation (the assistant in one thread, an MCP client with its app key)
	 * sees only the suggestions made there: the person's other suggestions, from Quick add or
	 * another app, are not its doing. A member asking directly sees all of their own. Only the
	 * person's own suggestions are listed, and one addressed to someone else never is.
	 */
	const mySuggestions = defineAction({
		id: 'core.mySuggestions',
		title: "Read the status of the member's recent suggestions",
		input: z.object({ limit: z.number().int().min(1).max(30).default(15) }),
		output: z.object({
			suggestions: z.array(
				z.object({
					id: z.string(),
					/** What this suggestion is: the action and the thing it is about. */
					label: z.string(),
					/** The Quick add group it came from, when it came from one (not a name for this suggestion). */
					group: z.string().optional(),
					status: z.enum(['waiting', 'approved', 'rejected', 'undone', 'expired', 'failed']),
					/** Why a rejected suggestion closed: taken back by the person, its subject is gone, or it was already so. */
					reason: z.enum(['withdrawn', 'gone', 'settled']).optional(),
					/** When it was suggested and, once decided, when; ISO 8601 UTC. */
					suggestedAt: z.string(),
					decidedAt: z.string().optional(),
					/**
					 * The name of the person who decided it (approved, rejected or took it back), as
					 * people call them: an agent repeats it, so it is never an id or a handle.
					 */
					decidedBy: z.string().optional(),
					/** Approved by the household's auto-approval setting, not by a person deciding it. */
					automatic: z.literal(true).optional(),
				}),
			),
		}),
		readOnly: true,
		ai: {
			description:
				"Lists the suggestions made in this conversation (the changes you proposed here for the person; for a connected app, the ones made through its app key), newest first, with what became of each: waiting, approved, rejected (withdrawn when the person took it back), undone, expired or failed, and who decided it (decidedBy, the person's name; automatic when the household's auto-approval approved it). Suggestions made elsewhere (Quick add, other conversations or apps) are not listed: never present them as made here. Use it when the person asks whether something was approved or added, or what is still waiting.",
		},
		async run(uow, { limit }) {
			const owner = memberBehind(uow.actor);
			if (owner === null) return { suggestions: [] };
			const rows = await uow.db
				.withTables<CoreTables>()
				.selectFrom('core_drafts')
				.selectAll()
				.where((eb) => eb.or([eb('for_member', 'is', null), eb('for_member', '=', owner)]))
				.orderBy('created_at', 'desc')
				.limit(MY_SUGGESTIONS_WINDOW)
				.execute();
			const passed = await deps.runner().passedCheck(uow.db);
			const actions = deps.registry().actions;
			const iso = (at: number) => new Date(at).toISOString();
			// An action's title is read from its own extension's tables, through this transaction.
			const ctxOf = (def: AnyActionDefinition) => ({
				db: deps.extensionDb(ownerOf(def.id), uow.db),
				family: uow.family,
				translate: uow.translate,
				vocabulary: uow.vocabulary,
				now: uow.clock.now(),
			});
			const actor = uow.actor;
			// An agent in a conversation: what was suggested there (an MCP draft also names its app
			// key as its source).
			const here =
				actor.kind === 'ai' && actor.sourceId !== undefined
					? (row: DraftRow, by: Actor) =>
							(by.kind === 'ai' && by.source === actor.source && by.sourceId === actor.sourceId) ||
							(row.source_kind === actor.source && row.source_id === actor.sourceId)
					: () => true;
			const mine = rows
				.filter((row) => {
					const by = JSON.parse(row.proposed_by) as Actor;
					const theirs = memberBehind(by) === owner;
					return theirs && here(row, by);
				})
				.slice(0, limit);
			const subjectFor = (row: DraftRow) => draftSubject(uow, row);
			// A change to one date of a repeating event says so, in the words and the date format
			// of the person it is for.
			const { locale, formatLocale, hourCycle } = await uow.family.settings();
			const language = (await uow.family.members()).find((m) => m.id === owner)?.locale ?? locale;
			const scopeFor = async (row: DraftRow) => {
				const def = actions.get(row.action_id);
				if (!def?.scopeNote) return undefined;
				try {
					const input = def.input.safeParse(readStoredInput(def, row.edited_input ?? row.input));
					const note = input.success ? await def.scopeNote(ctxOf(def), input.data) : null;
					return note
						? uow.translate(language, note.key, {
								date: formatDate(note.date, dateLocale(language, formatLocale, hourCycle), {
									day: 'numeric',
									month: 'short',
								}),
							})
						: undefined;
				} catch {
					return undefined;
				}
			};
			// Who decided, by name: an archived member still decided it, so the table is read.
			const deciders = [
				...new Set(mine.flatMap((row) => (row.decided_by === null ? [] : [row.decided_by]))),
			];
			const names = new Map(
				deciders.length === 0
					? []
					: (
							await members(uow.db)
								.selectFrom('core_members')
								.select(['id', 'display_name'])
								.where('id', 'in', deciders)
								.execute()
						).map((m) => [m.id, m.display_name]),
			);
			const goneIds = await deps.runner().goneAmong(
				mine.filter((row) => !passed(row)),
				uow.db,
			);
			const suggestions = await Promise.all(
				mine.map(async (row) => {
					const reason = goneIds.has(row.id) ? ('gone' as const) : draftReason(row);
					return {
						id: row.id,
						label: suggestionLabel(
							actions.get(row.action_id)?.title,
							row,
							await subjectFor(row),
							await scopeFor(row),
						),
						...(row.summary && { group: row.summary }),
						status: SUGGESTION_STATUS[passed(row) || goneIds.has(row.id) ? 'expired' : row.status],
						...(reason !== null && { reason }),
						suggestedAt: iso(row.created_at),
						...(row.decided_at !== null && { decidedAt: iso(row.decided_at) }),
						...(row.decided_by !== null &&
							names.has(row.decided_by) && { decidedBy: names.get(row.decided_by) }),
						...(row.auto_approved === 1 && { automatic: true as const }),
					};
				}),
			);
			return { suggestions };
		},
	});

	/**
	 * The suggestions waiting for the person asking: those they may decide (Quick add's cards,
	 * requests from others), wherever they were made, and their own that wait for someone else.
	 * A suggestion waits now, whatever days are asked about, so the span and the people asked about
	 * never leave one out; each stands on the span's first day it is asked about, and says the day
	 * it is about when it is about one. One the AI may not read (its area is off for it, or local
	 * only and the model is not) is counted as hidden, never shown.
	 */
	const suggestionsDigest = defineDigest({
		id: 'core.suggestionsDigest',
		topic: 'suggestions',
		title: 'Suggestions waiting for the person asking, for an answer',
		description:
			'The suggestions that wait for the person asking to approve or reject (Quick add cards, requests from others), newest first, and their own suggestions that wait for someone else; who suggested each, and the day it is about.',
		async run(uow, input) {
			const actor = uow.actor;
			const asker = memberBehind(actor);
			if (asker === null) return digestOf([], input);
			const [settings, people] = await Promise.all([uow.family.settings(), uow.family.members()]);
			const me = people.find((m) => m.id === asker);
			// Past the check above the caller is a member or an AI working for one, which both carry
			// the role they act with.
			const roleId = 'roleId' in actor ? actor.roleId : undefined;
			const role =
				roleId ??
				(
					await members(uow.db)
						.selectFrom('core_members')
						.select('role_id')
						.where('id', '=', asker)
						.executeTakeFirst()
				)?.role_id;
			if (role === undefined) return digestOf([], input);
			const person: Actor = { kind: 'member', memberId: asker, roleId: role };
			const rows = await uow.db
				.withTables<CoreTables>()
				.selectFrom('core_drafts')
				.selectAll()
				.where('status', 'in', [...WAITING_STATUSES])
				.where((eb) => eb.or([eb('for_member', 'is', null), eb('for_member', '=', asker)]))
				.orderBy('created_at', 'desc')
				.orderBy('id', 'desc')
				.limit(MY_SUGGESTIONS_WINDOW)
				.execute();
			const runner = deps.runner();
			const passed = await runner.passedCheck(uow.db);
			const actions = deps.registry().actions;
			const areas = deps.aiAreas();
			// What the AI may not look into stays out of what it reads, even counted as a title.
			const aiMayRead = (row: DraftRow) => {
				if (actor.kind !== 'ai') return true;
				const area = areas.access(ownerOf(row.action_id));
				return area === 'any' || (area === 'local' && actor.local === true);
			};
			const today = todayIn(settings.timeZone, uow.clock.now());
			const date = today < input.from ? input.from : today > input.to ? input.to : today;
			const language = me?.locale ?? settings.locale;
			const gone = await runner.goneAmong(rows, uow.db);
			const waiting = rows.filter(
				(row) =>
					!passed(row) &&
					!gone.has(row.id) &&
					(runner.mayDecide(row, person) || runner.isProposer(person, row)),
			);
			const readable = waiting.filter(aiMayRead);
			const items = await Promise.all(
				readable.map(async (row): Promise<DigestItem> => {
					const def = actions.get(row.action_id);
					const by = JSON.parse(row.proposed_by) as Actor;
					const from = memberBehind(by);
					const name = def?.draftTitle ? uow.translate(language, def.draftTitle) : def?.title;
					const day = def ? draftDateOf(def, row) : undefined;
					return {
						handle: row.id,
						kind: 'suggestion',
						title: suggestionLabel(name, row, await draftSubject(uow, row)).slice(0, 300),
						date,
						people: from ? [from] : [],
						status: row.status === 'failed' ? 'failed' : 'waiting',
						extra: {
							waitsFor: runner.mayDecide(row, person) ? 'asker' : 'others',
							suggestedOn: zoned(row.created_at, settings.timeZone).toPlainDate().toString(),
							...(day && { day }),
							...(row.summary && { group: row.summary.slice(0, 300) }),
						},
					};
				}),
			);
			return digestOf(items, input, {
				limit: SUGGESTIONS_DIGEST_LIMIT,
				hidden: waiting.length - readable.length,
			});
		},
	});

	return { mySuggestions, suggestionsDigest };
}
