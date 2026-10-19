import {
	type ActionResult,
	type ActionTarget,
	type Actor,
	type AnyActionDefinition,
	type Clock,
	compareThing,
	type DbExecutor,
	type DraftAlternative,
	type DraftMeta,
	type ExtensionFiles,
	FamosError,
	type IdGenerator,
	isFamosError,
	type JobQueue,
	type Logger,
	type MemberId,
	type NotifyRequest,
	type ProposalRefusal,
	type ProposalRefusalDetails,
	type SecretBox,
	subjectOf,
	targetOf,
	UNSURE_TARGET,
	type UndoStep,
	type UnitOfWork,
} from '@famos/sdk';
import { todayIn } from '@famos/time';
import { z } from 'zod';
import type { Access } from './access.ts';
import {
	AUTO_APPROVE_JOB,
	DEFAULT_DRAFT_NOTIFY_DELAY_MS,
	draftWhat,
	factsOf,
	qualifies,
	readAutoApproval,
	waitingNotice,
} from './auto-approval.ts';
import { draftCreated, draftUpdated, notificationRead } from './core-events.ts';
import {
	admission,
	type DecideEnv,
	type DecideFacts,
	type Decision,
	decide,
	needsOwner,
	refusalError,
} from './decide.ts';
import { dayOfSuggestion, draftDateOf, hasPassed, WAITING_STATUSES } from './draft-expiry.ts';
import { DECIDED_KIND, settleWaitingNotices, waitingDedupeKey } from './draft-notices.ts';
import type { InProcessEventBus } from './event-bus.ts';
import { familyReader } from './family.ts';
import { type Features, ownerOf } from './features.ts';
import {
	findStored,
	type IdempotencyRequest,
	IdempotentReplay,
	isStoredError,
	storeError,
	storeResult,
} from './idempotency.ts';
import type { Notifier } from './notifications.ts';
import type { Registry } from './registry.ts';
import { readStoredInput } from './stored-input.ts';
import type { CoreTables, DraftRow } from './tables.ts';

export type { DraftMeta };

export interface InvokeOptions {
	/** Metadata stored on the draft if the action ends up needing approval. */
	draft?: DraftMeta;
	/**
	 * A client-chosen request key (members only). The same key for the same action
	 * returns the stored result without running anything again; the key is stored in the
	 * action's own transaction.
	 */
	idempotencyKey?: string;
	/** Called when the result came from a stored key instead of a new run. */
	onReplay?: () => void;
	/**
	 * The extension that asks (through its context). It may run its own actions and those its
	 * manifest's `calls` lists, or as an AI actor what the AI is offered. Left out: the host.
	 */
	caller?: string;
}

/** What the runner needs to give each extension its own view of a transaction. */
export interface ExtensionViews {
	/** `db` (the root connection or a transaction) as the extension sees it: its own tables. */
	db(extensionId: string, db: DbExecutor): DbExecutor;
	/** The extension's files, with grants read and written through `db`. */
	files(extensionId: string, db: DbExecutor): ExtensionFiles;
	secrets(extensionId: string): SecretBox;
}

export interface ActionRunnerDeps {
	db: DbExecutor;
	queue: JobQueue;
	clock: Clock;
	ids: IdGenerator;
	logger: Logger;
	views: ExtensionViews;
	bus: InProcessEventBus;
	registry: Registry;
	/** Capability checks. */
	access: Access;
	/** Turned-off extensions' actions are refused. */
	features: Pick<Features, 'isOn'>;
	/** AI access per area: the AI runs nothing in an area that is off. */
	aiAreaAccess?: (extensionId: string) => 'off' | 'local' | 'any';
	/** Enqueues notifications in the caller's transaction. */
	notifier: Notifier;
	/** Renders translation keys (see `UnitOfWork.translate`). */
	translate: (locale: string, key: string, params?: Record<string, unknown>) => string;
	/** The words a key lists in every installed language (see `UnitOfWork.vocabulary`). */
	vocabulary: (key: string) => readonly string[];
	/** Family search: the indexer a unit of work hands to actions. */
	indexer: (enqueue: UnitOfWork['enqueue'], trx: UnitOfWork['db']) => UnitOfWork['ai'];
	/** Called after a commit that enqueued jobs, so the worker can wake up early. */
	onJobsEnqueued?: () => void;
	/** How long a suggestion waits before it notifies approvers (default 30 s). */
	draftNotifyDelayMs?: number;
}

/** Why a waiting draft cannot be decided: see `ActionRunner.unavailable`. */
export interface DraftUnavailable {
	reason: 'not_installed' | 'turned_off';
	/** The extension its action belongs to. */
	extension: string;
}

export interface ActionRunner {
	invoke<O = unknown>(
		actionId: string,
		input: unknown,
		actor: Actor,
		options?: InvokeOptions,
	): Promise<ActionResult<O>>;
	approveDraft(
		draftId: string,
		approver: Actor,
		editedInput?: unknown,
		options?: { auto?: boolean },
	): Promise<DraftRow>;
	rejectDraft(draftId: string, approver: Actor): Promise<DraftRow>;
	/**
	 * What running an action with this input would do for this actor (apply, draft or refuse),
	 * decided exactly as `invoke` decides it, without running anything or recording it.
	 */
	check(actionId: string, input: unknown, actor: Actor): Promise<Decision>;
	/** The decision for every data-changing action that is on, for any input (see `decide`). */
	decisions(actor: Actor): Record<string, Decision>;
	/** Takes back an applied draft with its action's inverse, in one transaction. */
	undoDraft(draftId: string, approver: Actor): Promise<DraftRow>;
	/**
	 * Sends an undone draft again as a new waiting one, for the person behind it: the change it
	 * applied, with the same source and notes, decided like any other. Once per undone draft.
	 */
	suggestAgain(draftId: string, actor: Actor): Promise<DraftRow>;
	/** Whether an undone draft was suggested again already. */
	suggestedAgain(draft: DraftRow): Promise<boolean>;
	/** The inverse step of an applied draft, or null when it cannot be undone. */
	undoStep(draft: DraftRow): UndoStep | null;
	/** Whether this actor could decide the draft: it is theirs, or they are an approver for it. */
	mayDecide(draft: DraftRow, actor: Actor): boolean;
	/** Whether this actor is the member behind the draft (who proposed it, or who the AI proposed it for). */
	isProposer(actor: Actor, draft: DraftRow): boolean;
	/**
	 * Why nobody can decide a waiting draft right now: the extension its action belongs to is not
	 * installed, or is turned off. Null when its action runs. The draft is kept: a reinstall (or
	 * switching the extension on) brings it back as an ordinary waiting suggestion.
	 */
	unavailable(draft: DraftRow): DraftUnavailable | null;
	/**
	 * Saves what a person changed on a waiting suggestion (`core.editDraft`), validated by its
	 * action's input schema. Whoever may decide it, or is the member behind it, may. Approving then
	 * applies the saved edit. Runs inside the caller's unit of work.
	 */
	editDraft(uow: UnitOfWork, draftId: string, input: unknown): Promise<DraftRow>;
	/** Whether a pending draft's change seems to exist already (the action's `alreadyThere`). */
	mayExist(draft: DraftRow): Promise<boolean | 'some'>;
	/**
	 * What the fields a pending draft would change hold now (the action's `currentValues`), keyed
	 * like its input. Null when the action has none, the draft is decided, or the thing is gone.
	 */
	currentValues(draft: DraftRow): Promise<Record<string, unknown> | null>;
	/**
	 * What a draft is about, by name ("Piano lesson"): the label stored with it, else what the
	 * thing it points at is called now. Null when nothing names it.
	 */
	subject(draft: DraftRow): Promise<string | null>;
	/**
	 * What a pending draft could become instead (the action's `instead`), as it would be stored:
	 * resolved, checked and labelled with the real title of what it changes. Null when nothing fits.
	 */
	alternative(draft: DraftRow): Promise<DraftAlternative | null>;
	/**
	 * Turns a pending draft into its alternative, decided by whoever may decide both the draft and
	 * the alternative. It stays pending: the change is then approved like any other, with its undo.
	 */
	replaceDraft(draftId: string, actor: Actor): Promise<DraftRow>;
	/**
	 * A check, for today in the family's time zone, of whether a waiting draft is about a day that
	 * has passed: it is shown and counted as expired even before `expirePassed` ran. Inside a unit
	 * of work pass its `db` (the one connection is held by the transaction).
	 */
	passedCheck(db?: DbExecutor): Promise<(draft: PassedFacts) => boolean>;
	/**
	 * The waiting drafts among `drafts` whose target (`target` of their action) is gone: deleted,
	 * archived or never there. They can never be applied, so lists and counts of what needs a
	 * decision leave them out and show them as closed. One query per table, however many drafts.
	 * Inside a unit of work pass its `db`.
	 */
	goneAmong(drafts: readonly DraftRow[], db?: DbExecutor): Promise<ReadonlySet<string>>;
	/** Marks every waiting draft whose day has passed `expired`. Idempotent; returns how many. */
	expirePassed(): Promise<number>;
}

/** What `passedCheck` needs of a draft. */
export type PassedFacts = Pick<DraftRow, 'action_id' | 'status' | 'input' | 'edited_input'>;

/** The value a mark points at: a field of the input, or a part of one (`items.0.title`). */
function fieldOf(input: unknown, mark: string): unknown {
	let at = input;
	for (const part of mark.split('.')) {
		if (at === null || typeof at !== 'object') return undefined;
		at = (at as Record<string, unknown>)[part];
	}
	return at;
}

/** Whether two values are the same JSON, whatever the order of their keys. */
function sameValue(a: unknown, b: unknown): boolean {
	const stable = (value: unknown): string =>
		JSON.stringify(value, (_key, v: unknown) =>
			v && typeof v === 'object' && !Array.isArray(v)
				? Object.fromEntries(Object.entries(v).toSorted(([x], [y]) => x.localeCompare(y)))
				: v,
		) ?? 'undefined';
	return stable(a) === stable(b);
}

function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
	const result = schema.safeParse(value);
	if (!result.success)
		throw new FamosError('bad_request', `Invalid ${what}`, z.treeifyError(result.error));
	return result.data;
}

/**
 * Ends a refusal that settles the matter. A model that reads only "already ticked off" tends to
 * look for another way to do something for the same request (putting the item back on the list),
 * so the refusal tells it to stop and say so.
 */
const CLOSED_MATTER = ' Tell the person this and do not suggest anything else for it.';

/** A draft keeps at most this much of the message it rests on: a line on its card, not a copy. */
const QUOTE_MAX = 300;

/**
 * The `details` of a refused AI proposal, so a caller can tell the person why it was left out
 * without reading the English message: what it asked for is already so (`settled`), it named
 * something other than what it pointed at (`other_target`) or only partly named it
 * (`unsure_target`), or it named nothing (`no_label`).
 * `subject` is what it was about, in the stored title or the model's words, when known.
 */
const refusal = (refused: ProposalRefusal, subject?: string | null): ProposalRefusalDetails => ({
	refused,
	...(subject && { subject }),
});

/** `core_drafts.error` of a draft closed because what it was about no longer exists. */
export const GONE = 'gone';

/** What a target's table must have: its id column. */
type RowWithId = { id: string; [column: string]: unknown };

/** `core_drafts.error` of a draft closed because what it asks for was already so. */
export const SETTLED = 'settled';

export function createActionRunner(deps: ActionRunnerDeps): ActionRunner {
	const { registry, bus, clock, ids, logger, access } = deps;
	const can = (actor: Actor, capability: string) => access.can(actor, capability);
	const criticalCapabilities = new Set(
		registry.capabilities.filter((c) => c.critical === true).map((c) => c.id),
	);

	const env: DecideEnv = {
		access,
		critical: criticalCapabilities,
		...(deps.aiAreaAccess && { aiArea: deps.aiAreaAccess }),
	};

	/** Who may invoke at all (see `admission`); approval is decided separately. */
	function authorize(def: AnyActionDefinition, actor: Actor): void {
		const refusal = admission(def, actor, env);
		if (refusal) throw refusalError(refusal);
	}

	/**
	 * The decision for one parsed input: the facts it needs are read here (the owner only when the
	 * decision turns on it, since that costs a query).
	 */
	async function decideInput(
		def: AnyActionDefinition,
		actor: Actor,
		input: unknown,
		settled: string | null,
	): Promise<Decision> {
		const facts: DecideFacts = { input, settled };
		const policy = def.approval;
		if (typeof policy === 'object' && policy.owner && needsOwner(def, actor, env, facts))
			facts.owner = await policy.owner(readContext(def), input);
		return decide(def, actor, env, facts);
	}

	/** Why an AI's proposal would change nothing (the action's `refuseProposal`), or null. */
	async function settledReason(def: AnyActionDefinition, actor: Actor, input: unknown) {
		if (actor.kind !== 'ai' || !def.refuseProposal) return null;
		return def.refuseProposal(readContext(def), input);
	}

	function decisionsFor(actor: Actor): Record<string, Decision> {
		const out: Record<string, Decision> = {};
		for (const def of registry.actions.values()) {
			if (def.readOnly || !deps.features.isOn(ownerOf(def.id))) continue;
			out[def.id] = decide(def, actor, env);
		}
		return out;
	}

	async function check(actionId: string, rawInput: unknown, actor: Actor): Promise<Decision> {
		const def = getAction(actionId);
		const before = decide(def, actor, env);
		if (before.outcome === 'refuse' && !before.depends) return before;
		const parsed = parseOrThrow(def.input, rawInput, `input for ${actionId}`);
		const input = def.resolveNames ? await def.resolveNames(readContext(def), parsed) : parsed;
		return decideInput(def, actor, input, await settledReason(def, actor, input));
	}
	const coreDb = () => deps.db.withTables<CoreTables>();

	/** A decided suggestion no longer waits: its unread "waiting" notices are marked read. */
	async function settleNotices(
		uow: UnitOfWork,
		draft: { id: string; source_kind: string | null; source_id: string | null },
	): Promise<void> {
		for (const memberId of await settleWaitingNotices(uow.db, draft))
			uow.emit(notificationRead, { memberId });
	}

	const getAction = (actionId: string) => {
		const def = registry.actions.get(actionId);
		if (!def) throw new FamosError('not_found', `Unknown action "${actionId}"`);
		if (!deps.features.isOn(ownerOf(actionId)))
			throw new FamosError('feature_off', `${ownerOf(actionId)} is turned off`);
		return def;
	};

	const manifests = new Map(registry.extensions.map((e) => [e.id, e.manifest]));
	const contextActions = new Set(registry.extensions.flatMap((e) => [e.ai?.context ?? []].flat()));

	/**
	 * Whether an extension may run an action: its own, one its manifest's `calls` lists, or, as an
	 * AI actor, one the AI is offered (the Inbox and the assistant act for the AI). The host and
	 * core may run any. What the actor may do is checked separately, by `authorize`.
	 */
	function assertCallable(caller: string, def: AnyActionDefinition, actor: Actor): void {
		if (caller === 'core' || ownerOf(def.id) === caller) return;
		if (manifests.get(caller)?.calls.includes(def.id)) return;
		if (actor.kind === 'ai' && (def.ai !== undefined || contextActions.has(def.id))) return;
		throw new FamosError(
			'forbidden',
			`Extension "${caller}" may not run ${def.id}: list it in famos.calls of its package.json`,
		);
	}

	/** What an action's checks read (names, titles, duplicates) see: its extension's tables. */
	const readContext = (def: AnyActionDefinition, db: DbExecutor = deps.db) => ({
		db: deps.views.db(ownerOf(def.id), db),
		family: familyReader(db),
		translate: deps.translate,
		now: deps.clock.now(),
	});

	/**
	 * Runs `work` in one transaction; events and job wake-ups fire only after commit. `work` gets
	 * the host's unit of work (core's bookkeeping: drafts, audit) and `view`, which gives an
	 * extension's action its own view of the same transaction.
	 */
	async function unitOfWork<T>(
		actor: Actor,
		work: (uow: UnitOfWork, view: (extensionId: string) => UnitOfWork) => Promise<T>,
	): Promise<T> {
		const events: [string, unknown][] = [];
		let enqueued = 0;
		const result = await deps.db.transaction().execute(async (trx) => {
			const enqueue: UnitOfWork['enqueue'] = async (job, payload, options) => {
				const def = registry.jobs.get(job);
				if (!def) throw new Error(`Unknown job "${job}"`);
				enqueued++;
				return deps.queue.enqueue(trx, job, def.payload.parse(payload), {
					maxAttempts: def.maxAttempts,
					...options,
				});
			};
			const views = new Map<string, UnitOfWork>();
			const view = (owner: string): UnitOfWork => {
				const known = views.get(owner);
				if (known) return known;
				const made = makeView(owner);
				views.set(owner, made);
				return made;
			};
			const makeView = (owner: string): UnitOfWork => ({
				db: deps.views.db(owner, trx),
				actor,
				clock,
				ids,
				logger,
				files: deps.views.files(owner, trx),
				secrets: deps.views.secrets(owner),
				family: familyReader(trx),
				translate: deps.translate,
				vocabulary: deps.vocabulary,
				ai: deps.indexer(enqueue, trx),
				can: (capability) => can(actor, capability),
				emit(event, payload) {
					events.push([event.name, event.payload.parse(payload)]);
				},
				enqueue,
				async notify(request) {
					enqueued++;
					await deps.notifier.enqueue(trx, request);
				},
				async rejectDraftsOf(source) {
					const waiting = await trx
						.withTables<CoreTables>()
						.selectFrom('core_drafts')
						.select(['id', 'action_id', 'source_kind', 'source_id', 'for_member'])
						.where('source_kind', '=', source.kind)
						.where('source_id', '=', source.id)
						.where('status', 'in', ['pending', 'failed'])
						.execute();
					const now = clock.now();
					for (const draft of waiting) {
						await trx
							.withTables<CoreTables>()
							.updateTable('core_drafts')
							.set({
								status: 'rejected',
								decided_by: actor.kind === 'member' ? actor.memberId : null,
								decided_at: now,
								updated_at: now,
							})
							.where('id', '=', draft.id)
							.execute();
						await audit(view('core'), draft.action_id, 'rejected', draft.id);
						view('core').emit(draftUpdated, {
							draftId: draft.id,
							status: 'rejected',
							forMember: draft.for_member,
						});
					}
					if (waiting[0]) await settleNotices(view('core'), waiting[0]);
					return waiting.length;
				},
				async run(actionId, input) {
					const def = getAction(actionId);
					assertCallable(owner, def, actor);
					authorize(def, actor);
					return def.run(
						view(ownerOf(def.id)),
						parseOrThrow(def.input, input, `input for ${actionId}`),
					);
				},
			});
			return work(view('core'), view);
		});
		if (enqueued > 0) deps.onJobsEnqueued?.();
		for (const [name, payload] of events) await bus.publish(name, payload);
		return result;
	}

	async function audit(
		uow: UnitOfWork,
		actionId: string,
		outcome: 'applied' | 'drafted' | 'rejected' | 'undone' | 'replaced',
		draftId: string | null,
	) {
		await uow.db
			.withTables<CoreTables>()
			.insertInto('core_audit_log')
			.values({
				at: clock.now(),
				actor: JSON.stringify(uow.actor),
				action_id: actionId,
				draft_id: draftId,
				outcome,
			})
			.execute();
	}

	async function apply(
		uow: UnitOfWork,
		view: (extensionId: string) => UnitOfWork,
		def: AnyActionDefinition,
		input: unknown,
		draftId: string | null,
		prepared?: unknown,
	) {
		const output = parseOrThrow(
			def.output,
			await def.run(view(ownerOf(def.id)), input, prepared),
			`output of ${def.id}`,
		);
		if (!def.readOnly) await audit(uow, def.id, 'applied', draftId);
		return output;
	}

	async function invoke<O>(
		actionId: string,
		rawInput: unknown,
		actor: Actor,
		options: InvokeOptions = {},
	): Promise<ActionResult<O>> {
		if (actor.kind !== 'member' || !options.idempotencyKey) {
			return invokeOnce(actionId, rawInput, actor, options, null);
		}
		const request: IdempotencyRequest = { key: options.idempotencyKey, memberId: actor.memberId };
		const replay = (stored: Awaited<ReturnType<typeof findStored>>) => {
			if (stored?.kind === 'error') throw stored.error;
			options.onReplay?.();
			return stored?.value as ActionResult<O>;
		};
		const stored = await findStored(deps.db, request, actionId);
		if (stored) return replay(stored);
		try {
			return await invokeOnce<O>(actionId, rawInput, actor, options, request);
		} catch (error) {
			if (error instanceof IdempotentReplay) return replay(error.stored);
			// Refusals are answered the same way next time; other failures stay retryable.
			if (isStoredError(error)) {
				await storeError(deps.db, request, actionId, clock.now(), error);
			}
			throw error;
		}
	}

	async function invokeOnce<O>(
		actionId: string,
		rawInput: unknown,
		actor: Actor,
		options: InvokeOptions,
		idem: IdempotencyRequest | null,
	): Promise<ActionResult<O>> {
		const def = getAction(actionId);
		assertCallable(options.caller ?? 'core', def, actor);
		// What is refused whatever the input is refused before the input is read.
		const before = decide(def, actor, env);
		if (before.outcome === 'refuse' && !before.depends) throw refusalError(before);
		const parsed = parseOrThrow(def.input, rawInput, `input for ${actionId}`);
		const input = def.resolveNames ? await def.resolveNames(readContext(def), parsed) : parsed;
		const { title: checkedTitle, unsure: targetUnsure } = await checkTarget(def, input, actor);
		const settled = await settledReason(def, actor, input);
		const decision = await decideInput(def, actor, input, settled);
		if (decision.outcome === 'refuse') {
			if (decision.reason === 'settled')
				throw new FamosError(
					'conflict',
					`${settled}${CLOSED_MATTER}`,
					refusal('settled', checkedTitle),
				);
			throw refusalError(decision);
		}
		/** Inside the transaction: a concurrent request may have stored the key meanwhile. */
		const guard = async (uow: UnitOfWork) => {
			if (!idem) return;
			const stored = await findStored(uow.db, idem, actionId);
			if (stored) throw new IdempotentReplay(stored);
		};
		const remember = (uow: UnitOfWork, result: ActionResult<unknown>) =>
			idem ? storeResult(uow.db, idem, actionId, clock.now(), result) : Promise.resolve();

		if (decision.outcome === 'apply') {
			// Slow or networked work (a model call) happens before the transaction opens.
			const prepared = def.prepare ? await def.prepare(input, actor) : undefined;
			const output = await unitOfWork(actor, async (uow, view) => {
				await guard(uow);
				const out = await apply(uow, view, def, input, null, prepared);
				await remember(uow, { status: 'applied', output: out });
				return out;
			});
			return { status: 'applied', output: output as O };
		}
		// A suggestion about something that is not there is refused as the direct run would be,
		// instead of waiting for a person to find out it can never be applied.
		if (await targetIsGone(def, input))
			throw new FamosError('not_found', 'What this changes was not found');
		const meta = options.draft ?? {};
		// Every draft carries the real name of what it changes, so cards and notices show what
		// will happen whoever proposed it (a screen sends only the id).
		const targetName = def.targetTitle
			? (checkedTitle ?? (await def.targetTitle(readContext(def), input)))
			: await namedSubject(def, input);
		const stored = targetName ? { ...(input as object), label: targetName.slice(0, 200) } : input;
		const subject = subjectOf(JSON.stringify(stored));
		const date = dayOfSuggestion(def, input);
		// A target the AI named only in another form of its words is shown as "check this".
		const uncertainFields = [
			...new Set([...(meta.uncertainFields ?? []), ...(targetUnsure ? [UNSURE_TARGET] : [])]),
		];
		// Personal drafts (memory, questions to a person) go to the member the assistant works for.
		const personalTo =
			actor.kind === 'ai' && def.ai?.addressToMember && actor.onBehalfOf ? actor.onBehalfOf : null;
		let draftId = ids.next('draft');
		let autoApproved = false;
		let byOthers = false;
		await unitOfWork(actor, async (uow) => {
			await guard(uow);
			if (meta.dedupeKey) {
				const existing = await uow.db
					.withTables<CoreTables>()
					.selectFrom('core_drafts')
					.select('id')
					.where('dedupe_key', '=', meta.dedupeKey)
					.executeTakeFirst();
				if (existing) {
					draftId = existing.id as typeof draftId;
					await remember(uow, {
						status: 'drafted',
						draftId,
						...(subject ? { subject } : {}),
						...(date ? { date } : {}),
					});
					return;
				}
			}
			const now = clock.now();
			// Auto-approval comes first: a job approves it, so it is not addressed to anyone.
			const setting = def.autoApprove ? (await readAutoApproval(uow.db))[actionId] : undefined;
			const personal = factsOf(actor, meta.forMember, personalTo);
			// A suggestion read from something a member shared belongs to that member: they may take
			// it back, and it is listed among their own.
			const proposer: Actor =
				actor.kind === 'ai' && !actor.onBehalfOf && meta.forMember
					? { ...actor, onBehalfOf: meta.forMember as MemberId }
					: actor;
			const auto =
				setting !== undefined &&
				personal.proposerMemberId !== null &&
				(await qualifies(uow.db, access, setting, personal));
			// Otherwise an AI draft belongs to the person behind it when they could decide it
			// themselves; if not (a supervised member), it goes to the approvers.
			const addressedTo =
				personalTo ??
				(!auto && actor.kind === 'ai' && personal.proposerMemberId !== null
					? await deciderBehind(uow, def, personal.proposerMemberId)
					: null);
			await uow.db
				.withTables<CoreTables>()
				.insertInto('core_drafts')
				.values({
					id: draftId,
					action_id: actionId,
					input: JSON.stringify(stored),
					edited_input: null,
					status: 'pending',
					proposed_by: JSON.stringify(proposer),
					source_kind: meta.sourceKind ?? null,
					source_id: meta.sourceId ?? null,
					summary: meta.summary ?? null,
					model: meta.model ?? null,
					prompt_version: meta.promptVersion ?? null,
					confidence: meta.confidence ?? null,
					uncertain_fields: uncertainFields.length ? JSON.stringify(uncertainFields) : null,
					quote: meta.quote?.trim() ? meta.quote.trim().slice(0, QUOTE_MAX) : null,
					dedupe_key: meta.dedupeKey ?? null,
					decided_by: null,
					decided_at: null,
					applied_at: null,
					result: null,
					error: null,
					for_member: addressedTo,
					created_at: now,
					updated_at: now,
				})
				.execute();
			await audit(uow, actionId, 'drafted', draftId);
			const facts = { ...personal, addressedTo };
			// A person's AI whose draft goes to the approvers: someone else decides it.
			byOthers = !auto && actor.kind === 'ai' && facts.proposerMemberId !== null && !addressedTo;
			uow.emit(draftCreated, {
				draftId,
				actionId,
				proposerKind: actor.kind,
				proposerMemberId: facts.proposerMemberId,
				sourceKind: meta.sourceKind ?? null,
				forMember: addressedTo,
			});
			// A draft addressed to one member needs no announcement: they are looking at it.
			if (addressedTo) {
				await remember(uow, {
					status: 'drafted',
					draftId,
					...(subject ? { subject } : {}),
					...(date ? { date } : {}),
				});
				return;
			}
			if (auto && facts.proposerMemberId !== null) {
				// Nobody is told it waits (the job does if it cannot approve).
				await uow.enqueue(
					AUTO_APPROVE_JOB,
					{ draftId, proposerMemberId: facts.proposerMemberId },
					{ dedupeKey: `${AUTO_APPROVE_JOB}:${draftId}` },
				);
				autoApproved = true;
				await remember(uow, {
					status: 'drafted',
					draftId,
					...(subject ? { subject } : {}),
					...(date ? { date } : {}),
				});
				return;
			}
			// Tell whoever may approve, and who asked; several drafts from one shared item collapse
			// into one.
			const who =
				facts.proposerMemberId === null
					? undefined
					: (await uow.family.members()).find((m) => m.id === facts.proposerMemberId)?.displayName;
			await uow.notify(
				waitingNotice(
					{
						id: draftId,
						summary: meta.summary ?? null,
						sourceKind: meta.sourceKind ?? null,
						sourceId: meta.sourceId ?? null,
						input: JSON.stringify(stored),
					},
					def,
					facts.proposerMemberId,
					deps.draftNotifyDelayMs ?? DEFAULT_DRAFT_NOTIFY_DELAY_MS,
					who,
				),
			);
			await remember(uow, {
				status: 'drafted',
				draftId,
				...(subject ? { subject } : {}),
				...(date ? { date } : {}),
			});
		});
		// The proposer is told too, so an AI can warn the person before they look at the card.
		const exists = await seemsToExist(def, input, { actionId });
		// And of what it could change instead: an agent tells the person, who chooses when deciding.
		const offered = autoApproved ? null : await alternativeOf(def, input, { actionId });
		const named = (offered?.input as { label?: unknown } | undefined)?.label;
		const instead =
			offered && typeof named === 'string'
				? {
						name: named,
						...(offered.at && { at: offered.at }),
						...(offered.to && { to: offered.to }),
					}
				: undefined;
		return {
			status: 'drafted',
			draftId,
			...(exists ? { mayExist: exists } : {}),
			...(instead && { instead }),
			...(autoApproved ? { autoApproval: true as const } : {}),
			...(byOthers ? { decidedByOthers: true as const } : {}),
			...(subject ? { subject } : {}),
			...(date ? { date } : {}),
		};
	}

	/**
	 * The person behind an AI draft, when they could decide it themselves: not archived, and
	 * holding `core.drafts.approve` and whatever the action needs (the same as `assertApprover`).
	 * Read through the transaction. Null when the draft should go to the approvers.
	 */
	async function deciderBehind(
		uow: UnitOfWork,
		def: AnyActionDefinition,
		memberId: string,
	): Promise<string | null> {
		const member = await uow.db
			.withTables<CoreTables>()
			.selectFrom('core_members')
			.select(['role_id', 'archived_at'])
			.where('id', '=', memberId)
			.executeTakeFirst();
		if (!member || member.archived_at !== null) return null;
		const held = access.effective(member.role_id);
		if (!held.has('core.drafts.approve')) return null;
		if (def.requires && !held.has(def.requires)) return null;
		if (typeof def.approval === 'object' && !held.has(def.approval.unless)) return null;
		return memberId;
	}

	const getDraft = async (db: DbExecutor, id: string) => {
		const row = await db
			.withTables<CoreTables>()
			.selectFrom('core_drafts')
			.selectAll()
			.where('id', '=', id)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', `Unknown draft "${id}"`);
		return row;
	};

	/**
	 * A draft addressed to a member is theirs alone to see and decide; anyone else does not even
	 * learn it exists. Checked before anything else, replays included.
	 */
	function assertAddressee(approver: Actor, draft: DraftRow): void {
		if (
			draft.for_member !== null &&
			(approver.kind !== 'member' || approver.memberId !== draft.for_member)
		)
			throw new FamosError('not_found', `Unknown draft "${draft.id}"`);
	}

	/**
	 * Deciding a draft needs `core.drafts.approve` and whatever would have let the approver make
	 * the change directly.
	 */
	function assertApprover(approver: Actor, def: AnyActionDefinition, draft: DraftRow): string {
		// The addressee needs no approval capability for a draft that is theirs alone.
		if (draft.for_member !== null) {
			assertAddressee(approver, draft);
		} else if (approver.kind !== 'member' || !can(approver, 'core.drafts.approve')) {
			throw refusalError({ reason: 'capability', capability: 'core.drafts.approve' });
		}
		if (approver.kind !== 'member')
			throw refusalError({ reason: 'capability', capability: 'core.drafts.approve' });
		authorize(def, approver);
		if (typeof def.approval === 'object' && !can(approver, def.approval.unless)) {
			throw refusalError({ reason: 'capability', capability: def.approval.unless });
		}
		return approver.memberId;
	}

	function unavailable(draft: DraftRow): DraftUnavailable | null {
		const extension = ownerOf(draft.action_id);
		if (!registry.actions.has(draft.action_id)) return { reason: 'not_installed', extension };
		return deps.features.isOn(extension) ? null : { reason: 'turned_off', extension };
	}

	function mayDecide(draft: DraftRow, actor: Actor): boolean {
		const def = registry.actions.get(draft.action_id);
		if (!def || unavailable(draft)) return false;
		try {
			assertApprover(actor, def, draft);
			return true;
		} catch (error) {
			if (isFamosError(error)) return false;
			throw error;
		}
	}

	/** The member behind a draft: who proposed it, or who the AI proposed it for. */
	function proposerOf(draft: DraftRow): string | null {
		const by = JSON.parse(draft.proposed_by) as Actor;
		if (by.kind === 'member') return by.memberId;
		return by.kind === 'ai' ? (by.onBehalfOf ?? null) : null;
	}

	/** Whether this actor is the member behind the draft (they may take their own suggestion back). */
	function isProposer(actor: Actor, draft: DraftRow): boolean {
		return actor.kind === 'member' && proposerOf(draft) === actor.memberId;
	}

	async function editDraft(uow: UnitOfWork, draftId: string, input: unknown): Promise<DraftRow> {
		const actor = uow.actor;
		const draft = await getDraft(uow.db, draftId);
		assertAddressee(actor, draft);
		if (actor.kind !== 'member')
			throw new FamosError('forbidden', 'Only a person edits a suggestion');
		const waits = unavailable(draft) !== null;
		const allowed =
			isProposer(actor, draft) ||
			mayDecide(draft, actor) ||
			(waits && can(actor, 'core.drafts.approve'));
		if (!allowed) throw refusalError({ reason: 'capability', capability: 'core.drafts.approve' });
		if (draft.status !== 'pending')
			throw new FamosError('conflict', `Draft is ${draft.status}; only a waiting one is edited`);
		if (waits)
			throw new FamosError(
				'conflict',
				'This suggestion waits until its extension is back, so it cannot be edited now',
			);
		const def = getAction(draft.action_id);
		const parsed = parseOrThrow(def.input, input, `input for ${def.id}`);
		// A field a person changed is no longer a guess: they looked at it. Marks on the fields
		// they left alone stay.
		const before = def.input.safeParse(readStoredInput(def, draft.edited_input ?? draft.input));
		const marks: string[] = draft.uncertain_fields ? JSON.parse(draft.uncertain_fields) : [];
		const kept = marks.filter(
			(mark) => !before.success || sameValue(fieldOf(before.data, mark), fieldOf(parsed, mark)),
		);
		await uow.db
			.withTables<CoreTables>()
			.updateTable('core_drafts')
			.set({
				edited_input: JSON.stringify(parsed),
				uncertain_fields: kept.length > 0 ? JSON.stringify(kept) : null,
				updated_at: uow.clock.now(),
			})
			.where('id', '=', draftId)
			.where('status', '=', 'pending')
			.execute();
		uow.emit(draftUpdated, { draftId, status: 'pending', forMember: draft.for_member });
		return getDraft(uow.db, draftId);
	}

	async function approveDraft(
		draftId: string,
		approver: Actor,
		editedInput?: unknown,
		options: { auto?: boolean } = {},
	): Promise<DraftRow> {
		const draft = await getDraft(deps.db, draftId);
		assertAddressee(approver, draft);
		if (draft.status === 'applied') return draft; // idempotent
		// What was taken back stays taken back: the person behind it may send it again as a new
		// suggestion, which is decided like any other.
		if (draft.status === 'undone')
			throw new FamosError(
				'conflict',
				'Draft is undone, so it cannot be approved again. The person who suggested it can suggest it again (core.suggestDraftAgain), and that new suggestion is approved as usual.',
				{ status: 'undone', next: 'core.suggestDraftAgain' },
			);
		if (draft.status !== 'pending' && draft.status !== 'failed') {
			throw new FamosError('conflict', `Draft is ${draft.status}`);
		}
		const def = getAction(draft.action_id);
		const approverId = assertApprover(approver, def, draft);
		const input = parseOrThrow(
			def.input,
			editedInput ?? readStoredInput(def, draft.edited_input ?? draft.input),
			`input for ${def.id}`,
		);
		// A suggestion about a day that has passed never runs (unless an edit moved it on).
		if ((await passedCheck())({ ...draft, edited_input: JSON.stringify(input) }))
			throw new FamosError('conflict', 'Draft is expired');
		// What the household's own setting approved is no news to the person behind it.
		const told = options.auto ? null : await decidedNotice(draft, def, approverId, 'approved');

		try {
			await unitOfWork(approver, async (uow, view) => {
				const now = clock.now();
				const claimed = await uow.db
					.withTables<CoreTables>()
					.updateTable('core_drafts')
					.set({
						status: 'approved',
						decided_by: approverId,
						decided_at: now,
						updated_at: now,
						...(options.auto && { auto_approved: 1 }),
					})
					.where('id', '=', draftId)
					.where('status', 'in', ['pending', 'failed'])
					.executeTakeFirst();
				if (Number(claimed.numUpdatedRows) === 0)
					throw new FamosError('conflict', 'Draft was decided concurrently');

				// Already so (ticked, done): running it changes nothing, and recording it as
				// applied would offer an undo that reverses somebody else's real change.
				if (
					def.settled &&
					(await def.settled(
						{
							db: view(ownerOf(def.id)).db,
							family: uow.family,
							translate: deps.translate,
							now: clock.now(),
						},
						input,
					))
				) {
					await uow.db
						.withTables<CoreTables>()
						.updateTable('core_drafts')
						.set({ status: 'rejected', error: SETTLED, updated_at: clock.now() })
						.where('id', '=', draftId)
						.execute();
					await audit(uow, draft.action_id, 'rejected', draftId);
					uow.emit(draftUpdated, { draftId, status: 'rejected', forMember: draft.for_member });
					await settleNotices(uow, draft);
					return;
				}

				const output = await apply(uow, view, def, input, draftId);
				await uow.db
					.withTables<CoreTables>()
					.updateTable('core_drafts')
					.set({
						status: 'applied',
						applied_at: clock.now(),
						// A saved edit stays; an edit sent with the approval replaces it.
						...(editedInput !== undefined && { edited_input: JSON.stringify(input) }),
						result: JSON.stringify(output ?? null),
						error: null,
						updated_at: clock.now(),
					})
					.where('id', '=', draftId)
					.execute();
				uow.emit(draftUpdated, { draftId, status: 'applied', forMember: draft.for_member });
				await settleNotices(uow, draft);
				if (told) await uow.notify(told);
			});
		} catch (error) {
			// What it is about is gone: the draft can never be applied, so it leaves the queue
			// (a retry would only fail again) and says why.
			if (isFamosError(error) && error.code === 'not_found')
				return closeAsGone(draft, approver, approverId);
			// Domain errors (validation, permissions, conflicts) leave the draft untouched.
			if (isFamosError(error)) throw error;
			logger.error({ err: error, draftId }, 'applying draft failed');
			await coreDb()
				.updateTable('core_drafts')
				.set({
					status: 'failed',
					error: error instanceof Error ? error.message : String(error),
					updated_at: clock.now(),
				})
				.where('id', '=', draftId)
				.execute();
			await bus.publish(draftUpdated.name, {
				draftId,
				status: 'failed',
				forMember: draft.for_member,
			});
			throw new FamosError('unavailable', 'Applying the draft failed; it can be retried');
		}
		return getDraft(deps.db, draftId);
	}

	/** Closes a waiting draft whose subject no longer exists; the reason is `error: 'gone'`. */
	async function closeAsGone(
		draft: DraftRow,
		approver: Actor,
		decidedBy: string,
	): Promise<DraftRow> {
		await unitOfWork(approver, async (uow) => {
			const now = clock.now();
			const closed = await uow.db
				.withTables<CoreTables>()
				.updateTable('core_drafts')
				.set({
					status: 'rejected',
					decided_by: decidedBy,
					decided_at: now,
					error: GONE,
					updated_at: now,
				})
				.where('id', '=', draft.id)
				.where('status', 'in', ['pending', 'failed'])
				.executeTakeFirst();
			if (Number(closed.numUpdatedRows) === 0) return;
			await audit(uow, draft.action_id, 'rejected', draft.id);
			uow.emit(draftUpdated, {
				draftId: draft.id,
				status: 'rejected',
				forMember: draft.for_member,
			});
			await settleNotices(uow, draft);
		});
		return getDraft(deps.db, draft.id);
	}

	/**
	 * Rejecting needs the same standing as approving; the member behind a draft may always take
	 * their own back (withdraw it), even without `core.drafts.approve`.
	 */
	async function rejectDraft(draftId: string, approver: Actor): Promise<DraftRow> {
		const draft = await getDraft(deps.db, draftId);
		assertAddressee(approver, draft);
		if (draft.status === 'rejected') return draft;
		if (draft.status !== 'pending' && draft.status !== 'failed')
			throw new FamosError('conflict', `Draft is ${draft.status}`);
		const approverId =
			isProposer(approver, draft) && approver.kind === 'member'
				? approver.memberId
				: assertApprover(approver, getAction(draft.action_id), draft);
		const def = registry.actions.get(draft.action_id);
		const told = def ? await decidedNotice(draft, def, approverId, 'rejected') : null;
		await unitOfWork(approver, async (uow) => {
			const now = clock.now();
			await uow.db
				.withTables<CoreTables>()
				.updateTable('core_drafts')
				.set({ status: 'rejected', decided_by: approverId, decided_at: now, updated_at: now })
				.where('id', '=', draftId)
				.execute();
			await audit(uow, draft.action_id, 'rejected', draftId);
			uow.emit(draftUpdated, { draftId, status: 'rejected', forMember: draft.for_member });
			await settleNotices(uow, draft);
			if (told) await uow.notify(told);
		});
		return getDraft(deps.db, draftId);
	}

	function undoStep(draft: DraftRow): UndoStep | null {
		if (draft.status !== 'applied' || draft.result === null) return null;
		const def = registry.actions.get(draft.action_id);
		if (!def?.undo) return null;
		// Results stored by an older version may not match today's output shape: not undoable.
		const output = def.output.safeParse(JSON.parse(draft.result));
		return output.success ? def.undo(output.data) : null;
	}

	/**
	 * The real title of what an input points at, for actions that have a `targetTitle`. An AI must
	 * say in the person's own words which thing it means (`label`), and those words must name the
	 * target: a model that picked the closest thing instead of the named one is refused, so it
	 * tells the person it is not there. Null when the action has no target title or the target
	 * does not exist (the action then reports that itself).
	 */
	async function checkTarget(
		def: AnyActionDefinition,
		input: unknown,
		actor: Actor,
	): Promise<{ title: string | null | undefined; unsure: boolean }> {
		// People see what they pick: nothing to check, and no query unless a draft needs the name.
		if (actor.kind !== 'ai') return { title: undefined, unsure: false };
		const ctx = readContext(def);
		let title: string | null = null;
		let unsure = false;
		if (def.targetTitle) {
			const label = (input as { label?: unknown } | null)?.label;
			const said = typeof label === 'string' ? label.trim() : '';
			if (said === '')
				throw new FamosError(
					'conflict',
					'Say which one you mean: send `label` with the name the person used for it, in their words.',
					refusal('no_label'),
				);
			title = await def.targetTitle(ctx, input);
			if (title !== null) {
				const { locale } = await ctx.family.settings();
				const match = compareThing(said, title, { language: locale });
				const { band } = match;
				// The words in another form ("biology tests" for "Biology test") are a guess the
				// draft marks for a person to check; words that only partly name it are a question
				// for the person, never a change made on a guess.
				unsure = targetOf({ ...match, candidates: [title] }) === 'marked';
				if (band === 'weak' && !unsure)
					throw new FamosError(
						'conflict',
						`'${said}' may be '${title}', but does not surely name it. Ask the person which one they mean.`,
						refusal('unsure_target', said),
					);
				if (band === 'none')
					throw new FamosError(
						'conflict',
						`That is '${title}', not '${said}'.${CLOSED_MATTER}`,
						refusal('other_target', said),
					);
			}
		}
		return { title, unsure };
	}

	/** Whether what an input proposes seems to exist already; only a hint, it never throws. */
	async function seemsToExist(
		def: AnyActionDefinition,
		input: unknown,
		what: Record<string, string>,
	): Promise<boolean | 'some'> {
		if (!def.alreadyThere || !deps.features.isOn(ownerOf(def.id))) return false;
		try {
			return await def.alreadyThere(readContext(def), input);
		} catch (error) {
			logger.warn({ err: error, ...what }, 'duplicate check failed');
			return false;
		}
	}

	async function mayExist(draft: DraftRow): Promise<boolean | 'some'> {
		if (draft.status !== 'pending') return false;
		const def = registry.actions.get(draft.action_id);
		if (!def) return false;
		const input = def.input.safeParse(readStoredInput(def, draft.edited_input ?? draft.input));
		if (!input.success) return false;
		return seemsToExist(def, input.data, { draftId: draft.id });
	}

	/**
	 * The alternative an action offers for an input, checked the way a proposal of that action is:
	 * a known, enabled, data-changing action, a valid input with names resolved, a target that
	 * exists and that the change would really change. Only a hint: it never throws.
	 */
	async function alternativeOf(
		def: AnyActionDefinition,
		input: unknown,
		what: Record<string, string>,
	): Promise<DraftAlternative | null> {
		if (!def.instead || !deps.features.isOn(ownerOf(def.id))) return null;
		try {
			const offered = await def.instead(readContext(def), input);
			if (!offered) return null;
			const next = registry.actions.get(offered.actionId);
			if (!next || next.readOnly || !deps.features.isOn(ownerOf(next.id))) return null;
			const parsed = next.input.safeParse(offered.input);
			if (!parsed.success) return null;
			const ctx = readContext(next);
			const resolved = next.resolveNames ? await next.resolveNames(ctx, parsed.data) : parsed.data;
			const title = next.targetTitle ? await next.targetTitle(ctx, resolved) : null;
			// The draft's own words must name what it would change, as an AI's label must: an
			// alternative is never the closest thing, whatever the action offering it found. A
			// match a person is asked to check (the same code, other forms of the words) is offered:
			// the person chooses it or not.
			const said = subjectOf(JSON.stringify(input));
			if (next.targetTitle) {
				const { locale } = await ctx.family.settings();
				if (title === null || !said) return null;
				const match = compareThing(said, title, { language: locale });
				if (targetOf({ ...match, candidates: [title] }) === null) return null;
			}
			if (next.refuseProposal && (await next.refuseProposal(ctx, resolved)) !== null) return null;
			// Stored like every draft of that action: with the real title of what it changes.
			const stored = title ? { ...(resolved as object), label: title.slice(0, 200) } : resolved;
			return {
				actionId: next.id,
				input: stored,
				...(offered.at && { at: offered.at }),
				...(offered.to && { to: offered.to }),
				...(offered.key && { key: offered.key }),
			};
		} catch (error) {
			logger.warn({ err: error, ...what }, 'finding an alternative failed');
			return null;
		}
	}

	async function alternative(draft: DraftRow): Promise<DraftAlternative | null> {
		if (draft.status !== 'pending') return null;
		const def = registry.actions.get(draft.action_id);
		if (!def?.instead) return null;
		const input = def.input.safeParse(readStoredInput(def, draft.input));
		if (!input.success) return null;
		return alternativeOf(def, input.data, { draftId: draft.id });
	}

	async function currentValues(draft: DraftRow): Promise<Record<string, unknown> | null> {
		if (draft.status !== 'pending' && draft.status !== 'failed') return null;
		const def = registry.actions.get(draft.action_id);
		if (!def?.currentValues || !deps.features.isOn(ownerOf(def.id))) return null;
		// The reviewer reads the draft as it would be approved: with a saved edit when there is one.
		const input = def.input.safeParse(readStoredInput(def, draft.edited_input ?? draft.input));
		if (!input.success) return null;
		try {
			return await def.currentValues(readContext(def), input.data);
		} catch (error) {
			logger.warn({ err: error, draftId: draft.id }, 'reading the current values failed');
			return null;
		}
	}

	/** The action's `subject` for an input; only a hint, it never throws. */
	async function namedSubject(def: AnyActionDefinition, input: unknown): Promise<string | null> {
		if (!def.subject) return null;
		try {
			return await def.subject(readContext(def), input);
		} catch (error) {
			logger.warn({ err: error, actionId: def.id }, 'naming the subject failed');
			return null;
		}
	}

	/**
	 * What a draft is about, by name: what its input says (the label stored with it), else what
	 * the thing it points at is called now (for a draft stored before it carried the name).
	 */
	async function subjectOfDraft(draft: DraftRow): Promise<string | null> {
		const raw = draft.edited_input ?? draft.input;
		const named = subjectOf(raw);
		if (named) return named;
		const def = registry.actions.get(draft.action_id);
		if (!def || (!def.targetTitle && !def.subject) || !deps.features.isOn(ownerOf(def.id)))
			return null;
		try {
			const input = def.input.safeParse(readStoredInput(def, raw));
			if (!input.success) return null;
			const name = def.targetTitle
				? await def.targetTitle(readContext(def), input.data)
				: await namedSubject(def, input.data);
			return name?.trim().slice(0, 80) || null;
		} catch (error) {
			logger.warn({ err: error, draftId: draft.id }, 'naming the subject failed');
			return null;
		}
	}

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

	async function replaceDraft(draftId: string, actor: Actor): Promise<DraftRow> {
		const draft = await getDraft(deps.db, draftId);
		assertAddressee(actor, draft);
		if (draft.status !== 'pending') throw new FamosError('conflict', `Draft is ${draft.status}`);
		// Choosing the alternative is a decision about the draft as it was proposed.
		assertApprover(actor, getAction(draft.action_id), draft);
		if (draft.replaced !== null) return draft; // idempotent
		// Worked out again here: what a client sends is never the alternative.
		const offered = await alternative(draft);
		if (!offered) throw new FamosError('conflict', 'There is nothing to do instead');
		const next = getAction(offered.actionId);
		// And about the change it becomes: nobody turns a draft into one they could not approve.
		assertApprover(actor, next, draft);
		const input = JSON.stringify(offered.input);
		if ((await passedCheck())({ ...draft, action_id: next.id, input, edited_input: null }))
			throw new FamosError('conflict', 'Draft is expired');
		await unitOfWork(actor, async (uow) => {
			const now = clock.now();
			const changed = await uow.db
				.withTables<CoreTables>()
				.updateTable('core_drafts')
				.set({
					action_id: next.id,
					input,
					edited_input: null,
					replaced: JSON.stringify({ actionId: draft.action_id, input: JSON.parse(draft.input) }),
					updated_at: now,
				})
				.where('id', '=', draftId)
				.where('status', '=', 'pending')
				.where('action_id', '=', draft.action_id)
				.executeTakeFirst();
			if (Number(changed.numUpdatedRows) === 0)
				throw new FamosError('conflict', 'Draft was decided concurrently');
			await audit(uow, draft.action_id, 'replaced', draftId);
			uow.emit(draftUpdated, { draftId, status: 'pending', forMember: draft.for_member });
		});
		return getDraft(deps.db, draftId);
	}

	async function undoDraft(draftId: string, approver: Actor): Promise<DraftRow> {
		const draft = await getDraft(deps.db, draftId);
		assertAddressee(approver, draft);
		if (draft.status === 'undone') return draft; // idempotent
		const step = undoStep(draft);
		if (!step) throw new FamosError('conflict', `Draft is ${draft.status} and cannot be undone`);
		assertApprover(approver, getAction(draft.action_id), draft);
		await unitOfWork(approver, async (uow) => {
			await uow.run(step.actionId, step.input);
			await uow.db
				.withTables<CoreTables>()
				.updateTable('core_drafts')
				.set({ status: 'undone', updated_at: clock.now() })
				.where('id', '=', draftId)
				.execute();
			await audit(uow, draft.action_id, 'undone', draftId);
			uow.emit(draftUpdated, { draftId, status: 'undone', forMember: draft.for_member });
		});
		return getDraft(deps.db, draftId);
	}

	const againKey = (draftId: string) => `again:${draftId}`;

	async function suggestedAgain(draft: DraftRow): Promise<boolean> {
		if (draft.status !== 'undone') return false;
		const row = await coreDb()
			.selectFrom('core_drafts')
			.select('id')
			.where('dedupe_key', '=', againKey(draft.id))
			.executeTakeFirst();
		return row !== undefined;
	}

	async function suggestAgain(draftId: string, actor: Actor): Promise<DraftRow> {
		const draft = await getDraft(deps.db, draftId);
		assertAddressee(actor, draft);
		if (!isProposer(actor, draft) || actor.kind !== 'member')
			throw new FamosError('forbidden', 'Only the person who suggested it can suggest it again');
		if (draft.status !== 'undone')
			throw new FamosError(
				'conflict',
				`Draft is ${draft.status}; only an undone one is suggested again`,
			);
		const def = getAction(draft.action_id);
		if (!can(actor, 'core.drafts.propose') && !mayDecide(draft, actor))
			throw refusalError({ reason: 'approval', capability: 'core.drafts.propose' });
		const dedupeKey = againKey(draft.id);
		const existing = await coreDb()
			.selectFrom('core_drafts')
			.selectAll()
			.where('dedupe_key', '=', dedupeKey)
			.executeTakeFirst();
		if (existing) return existing; // idempotent
		// What it applied, edits included, is what is suggested again (stored as it reads now).
		const input = JSON.stringify(readStoredInput(def, draft.edited_input ?? draft.input));
		if ((await passedCheck())({ ...draft, status: 'pending', input, edited_input: null }))
			throw new FamosError('conflict', 'Draft is expired');
		const id = ids.next('draft');
		await unitOfWork(actor, async (uow) => {
			const now = clock.now();
			await uow.db
				.withTables<CoreTables>()
				.insertInto('core_drafts')
				.values({
					id,
					action_id: draft.action_id,
					input,
					edited_input: null,
					status: 'pending',
					proposed_by: draft.proposed_by,
					source_kind: draft.source_kind,
					source_id: draft.source_id,
					summary: draft.summary,
					model: draft.model,
					prompt_version: draft.prompt_version,
					confidence: draft.confidence,
					uncertain_fields: draft.uncertain_fields,
					dedupe_key: dedupeKey,
					decided_by: null,
					decided_at: null,
					applied_at: null,
					result: null,
					error: null,
					for_member: draft.for_member,
					created_at: now,
					updated_at: now,
				})
				.execute();
			await audit(uow, draft.action_id, 'drafted', id);
			uow.emit(draftCreated, {
				draftId: id,
				actionId: draft.action_id,
				proposerKind: (JSON.parse(draft.proposed_by) as Actor).kind,
				proposerMemberId: actor.memberId,
				sourceKind: draft.source_kind,
				forMember: draft.for_member,
			});
			// A draft addressed to one member is theirs to decide; the others are told it waits.
			if (draft.for_member !== null) return;
			const who = (await uow.family.members()).find((m) => m.id === actor.memberId)?.displayName;
			await uow.notify(
				waitingNotice(
					{
						id,
						summary: draft.summary,
						sourceKind: draft.source_kind,
						sourceId: draft.source_id,
						input,
					},
					def,
					actor.memberId,
					deps.draftNotifyDelayMs ?? DEFAULT_DRAFT_NOTIFY_DELAY_MS,
					who,
				),
			);
		});
		return getDraft(deps.db, id);
	}

	async function passedCheck(db: DbExecutor = deps.db): Promise<(draft: PassedFacts) => boolean> {
		const { timeZone } = await familyReader(db).settings();
		const today = todayIn(timeZone, clock.now());
		return (draft) =>
			(WAITING_STATUSES as readonly string[]).includes(draft.status) &&
			hasPassed(draftDateOf(registry.actions.get(draft.action_id), draft), today);
	}

	/** Whether the row an input points at (`target` of the action) is missing or no longer live. */
	async function targetIsGone(def: AnyActionDefinition, input: unknown): Promise<boolean> {
		if (!def.target) return false;
		try {
			const target = def.target(input);
			if (!target) return false;
			const tables = deps.views
				.db(ownerOf(def.id), deps.db)
				.withTables<Record<string, RowWithId>>();
			let query = tables.selectFrom(target.table).select('id').where('id', '=', target.id);
			if (target.liveColumn) query = query.where(target.liveColumn, 'is', null);
			return (await query.executeTakeFirst()) === undefined;
		} catch (error) {
			// A table that cannot be read judges nothing: the suggestion is made as before.
			logger.warn({ err: error, action: def.id }, 'checking the target of a suggestion failed');
			return false;
		}
	}

	async function goneAmong(
		drafts: readonly DraftRow[],
		db: DbExecutor = deps.db,
	): Promise<ReadonlySet<string>> {
		// Drafts by the row they work on: one query per table and live column.
		const groups = new Map<
			string,
			{ extension: string; table: string; liveColumn?: string; ids: Map<string, string[]> }
		>();
		for (const draft of drafts) {
			if (!(WAITING_STATUSES as readonly string[]).includes(draft.status)) continue;
			const def = registry.actions.get(draft.action_id);
			// Not installed or turned off is its own state (`unavailable`), not a gone target.
			if (!def?.target || unavailable(draft)) continue;
			let target: ActionTarget | null = null;
			try {
				const input = def.input.safeParse(readStoredInput(def, draft.edited_input ?? draft.input));
				if (input.success) target = def.target(input.data);
			} catch {
				// An input stored by another version may not fit today's shape: it is not judged.
			}
			if (!target) continue;
			const extension = ownerOf(def.id);
			const key = `${extension}:${target.table}:${target.liveColumn ?? ''}`;
			const group = groups.get(key) ?? {
				extension,
				table: target.table,
				...(target.liveColumn && { liveColumn: target.liveColumn }),
				ids: new Map<string, string[]>(),
			};
			group.ids.set(target.id, [...(group.ids.get(target.id) ?? []), draft.id]);
			groups.set(key, group);
		}
		const gone = new Set<string>();
		for (const group of groups.values()) {
			try {
				const tables = deps.views.db(group.extension, db).withTables<Record<string, RowWithId>>();
				let query = tables
					.selectFrom(group.table)
					.select('id')
					.where('id', 'in', [...group.ids.keys()]);
				if (group.liveColumn) query = query.where(group.liveColumn, 'is', null);
				const live = new Set((await query.execute()).map((row) => row.id));
				for (const [id, draftIds] of group.ids)
					if (!live.has(id)) for (const draftId of draftIds) gone.add(draftId);
			} catch (error) {
				// A table that cannot be read judges nothing: the drafts stay as they are.
				logger.warn({ err: error, table: group.table }, 'checking the targets of drafts failed');
			}
		}
		return gone;
	}

	async function expirePassed(): Promise<number> {
		const passed = await passedCheck();
		const waiting = await coreDb()
			.selectFrom('core_drafts')
			.select([
				'id',
				'action_id',
				'status',
				'input',
				'edited_input',
				'source_kind',
				'source_id',
				'for_member',
			])
			.where('status', 'in', [...WAITING_STATUSES])
			.execute();
		const expired: { id: string; forMember: string | null }[] = [];
		for (const draft of waiting.filter(passed)) {
			const now = clock.now();
			// Only if still waiting: a person may have decided it meanwhile.
			const done = await coreDb()
				.updateTable('core_drafts')
				.set({ status: 'expired', decided_at: now, updated_at: now })
				.where('id', '=', draft.id)
				.where('status', 'in', [...WAITING_STATUSES])
				.executeTakeFirst();
			if (Number(done.numUpdatedRows) === 0) continue;
			expired.push({ id: draft.id, forMember: draft.for_member });
			for (const memberId of await settleWaitingNotices(deps.db, draft))
				await bus.publish(notificationRead.name, { memberId });
		}
		for (const { id, forMember } of expired)
			await bus.publish(draftUpdated.name, { draftId: id, status: 'expired', forMember });
		return expired.length;
	}

	return {
		invoke,
		check,
		decisions: decisionsFor,
		approveDraft,
		rejectDraft,
		undoDraft,
		suggestAgain,
		suggestedAgain,
		undoStep,
		mayExist,
		alternative,
		currentValues,
		subject: subjectOfDraft,
		replaceDraft,
		mayDecide,
		isProposer,
		unavailable,
		editDraft,
		passedCheck,
		goneAmong,
		expirePassed,
	};
}
