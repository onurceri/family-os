import {
	type ActionResult,
	type Actor,
	type AnyActionDefinition,
	type Clock,
	type DbExecutor,
	type DraftAlternative,
	type DraftMeta,
	type ExtensionFiles,
	FamosError,
	type IdGenerator,
	isFamosError,
	type JobQueue,
	type Logger,
	labelNamesTitle,
	type MemberId,
	type NotifyRequest,
	type ProposalRefusal,
	type ProposalRefusalDetails,
	type SecretBox,
	subjectOf,
	type UndoStep,
	type UnitOfWork,
} from '@famos/sdk';
import { todayIn } from '@famos/time';
import { z } from 'zod';
import { type Access, ANONYMOUS } from './access.ts';
import { mayUseAsAi } from './ai-tools.ts';
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
import { draftDateOf, hasPassed, WAITING_STATUSES } from './draft-expiry.ts';
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
	/** Takes back an applied draft with its action's inverse, in one transaction. */
	undoDraft(draftId: string, approver: Actor): Promise<DraftRow>;
	/** The inverse step of an applied draft, or null when it cannot be undone. */
	undoStep(draft: DraftRow): UndoStep | null;
	/** Whether this actor could decide the draft: it is theirs, or they are an approver for it. */
	mayDecide(draft: DraftRow, actor: Actor): boolean;
	/** Whether this actor is the member behind the draft (who proposed it, or who the AI proposed it for). */
	isProposer(actor: Actor, draft: DraftRow): boolean;
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
	/** Marks every waiting draft whose day has passed `expired`. Idempotent; returns how many. */
	expirePassed(): Promise<number>;
}

/** What `passedCheck` needs of a draft. */
export type PassedFacts = Pick<DraftRow, 'action_id' | 'status' | 'input' | 'edited_input'>;

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

/**
 * The `details` of a refused AI proposal, so a caller can tell the person why it was left out
 * without reading the English message: what it asked for is already so (`settled`), it named
 * something other than what it pointed at (`other_target`), or it named nothing (`no_label`).
 * `subject` is what it was about, in the stored title or the model's words, when known.
 */
const refusal = (refused: ProposalRefusal, subject?: string | null): ProposalRefusalDetails => ({
	refused,
	...(subject && { subject }),
});

/** `core_drafts.error` of a draft closed because what it was about no longer exists. */
export const GONE = 'gone';

/** `core_drafts.error` of a draft closed because what it asks for was already so. */
export const SETTLED = 'settled';

export function createActionRunner(deps: ActionRunnerDeps): ActionRunner {
	const { registry, bus, clock, ids, logger, access } = deps;
	const can = (actor: Actor, capability: string) => access.can(actor, capability);
	const criticalCapabilities = new Set(
		registry.capabilities.filter((c) => c.critical === true).map((c) => c.id),
	);

	/** Who may invoke at all: `requires`. AI and system actors are judged by policy. */
	function authorize(def: AnyActionDefinition, actor: Actor): void {
		// A display only looks: no action, not even a read-only one.
		if (actor.kind === 'display') {
			throw new FamosError('forbidden', `Displays cannot run ${def.id}`);
		}
		if (actor.kind === 'member' && def.requires && !can(actor, def.requires)) {
			throw new FamosError('forbidden', `Not allowed to run ${def.id}`);
		}
		// The AI is checked like a member: it may read what its capabilities and the
		// area switches allow, so a locked area refuses it. Its data-changing proposals are not
		// judged here (they only become drafts, which a person approves; `requires` is checked
		// against the approver).
		if (actor.kind === 'ai' && def.readOnly && def.requires && !can(actor, def.requires)) {
			throw new FamosError('forbidden', `The AI may not run ${def.id}`);
		}
		// Acting for a member, it never exceeds them: a change must be one that member
		// could make or propose, a read one their capabilities allow.
		if (actor.kind === 'ai' && !mayUseAsAi(access, def, actor)) {
			throw new FamosError('forbidden', `The AI may not run ${def.id} for this member`);
		}
		// What only an admin may do (a critical capability: installing extensions, managing
		// members) is a person's own act: the AI never runs it and never proposes it, not even for
		// an admin, so no draft of it can reach an approver.
		if (actor.kind === 'ai' && def.requires && criticalCapabilities.has(def.requires)) {
			throw new FamosError('forbidden', `The AI may not run ${def.id}`);
		}
		// A locked area is closed to the AI whatever its actions declare: no read (even without
		// `requires`) and no draft. Protection does not depend on each extension's discipline.
		if (actor.kind === 'ai' && deps.aiAreaAccess?.(ownerOf(def.id)) === 'off') {
			throw new FamosError('forbidden', `The AI may not use ${ownerOf(def.id)}`);
		}
		// An unauthenticated caller of a public route holds no capability: it can never run an
		// action that requires one (or change data at all). Routes that need bookkeeping use their
		// own named system actor.
		if (actor.kind === 'system' && actor.source === ANONYMOUS && (def.requires || !def.readOnly)) {
			throw new FamosError('forbidden', `Sign in to run ${def.id}`);
		}
	}

	/** Whether this call becomes a draft. AI is checked first: its changes are always drafts. */
	async function needsApproval(
		def: AnyActionDefinition,
		actor: Actor,
		input: unknown,
	): Promise<boolean> {
		if (def.readOnly) return false;
		if (actor.kind === 'ai') return true;
		const policy = def.approval;
		if (policy === 'never' || policy === 'ai') return false;
		if (policy === 'always') return true;
		if (typeof policy === 'object') {
			if (actor.kind !== 'member') return false;
			if (can(actor, policy.unless) || policy.except?.(actor, input) === true) return false;
			// Their own thing: what they could only have proposed, they may do directly. Owning a
			// thing never lets anyone do more than propose would have.
			if (policy.owner && can(actor, 'core.drafts.propose')) {
				const owner = await policy.owner(readContext(def), input);
				if (owner !== null && owner === actor.memberId) return false;
			}
			return true;
		}
		return policy(actor, input, (capability) => can(actor, capability));
	}
	const coreDb = () => deps.db.withTables<CoreTables>();

	/** A decided suggestion no longer waits: its unread "waiting" notices are marked read. */
	async function settleNotices(
		uow: UnitOfWork,
		draft: { id: string; source_kind: string | null; source_id: string | null },
	): Promise<void> {
		for (const memberId of await settleWaitingNotices(uow.db, draft, clock.now()))
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
						.select(['id', 'action_id', 'source_kind', 'source_id'])
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
						view('core').emit(draftUpdated, { draftId: draft.id, status: 'rejected' });
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
		authorize(def, actor);
		const parsed = parseOrThrow(def.input, rawInput, `input for ${actionId}`);
		const input = def.resolveNames ? await def.resolveNames(readContext(def), parsed) : parsed;
		const checkedTitle = await checkTarget(def, input, actor);
		/** Inside the transaction: a concurrent request may have stored the key meanwhile. */
		const guard = async (uow: UnitOfWork) => {
			if (!idem) return;
			const stored = await findStored(uow.db, idem, actionId);
			if (stored) throw new IdempotentReplay(stored);
		};
		const remember = (uow: UnitOfWork, result: ActionResult<unknown>) =>
			idem ? storeResult(uow.db, idem, actionId, clock.now(), result) : Promise.resolve();

		if (!(await needsApproval(def, actor, input))) {
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
		// Members without the capability may still propose, if their role allows proposing.
		if (actor.kind === 'member' && !can(actor, 'core.drafts.propose')) {
			throw new FamosError('forbidden', `Not allowed to run ${def.id}`);
		}

		const meta = options.draft ?? {};
		// Every draft carries the real name of what it changes, so cards and notices show what
		// will happen whoever proposed it (a screen sends only the id).
		const targetName = def.targetTitle
			? (checkedTitle ?? (await def.targetTitle(readContext(def), input)))
			: await namedSubject(def, input);
		const stored = targetName ? { ...(input as object), label: targetName.slice(0, 200) } : input;
		const subject = subjectOf(JSON.stringify(stored));
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
					await remember(uow, { status: 'drafted', draftId, ...(subject ? { subject } : {}) });
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
					uncertain_fields: meta.uncertainFields?.length
						? JSON.stringify(meta.uncertainFields)
						: null,
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
			});
			// A draft addressed to one member needs no announcement: they are looking at it.
			if (addressedTo) {
				await remember(uow, { status: 'drafted', draftId, ...(subject ? { subject } : {}) });
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
				await remember(uow, { status: 'drafted', draftId, ...(subject ? { subject } : {}) });
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
			await remember(uow, { status: 'drafted', draftId, ...(subject ? { subject } : {}) });
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
			throw new FamosError('forbidden', 'Not allowed to decide drafts');
		}
		if (approver.kind !== 'member')
			throw new FamosError('forbidden', 'Not allowed to decide drafts');
		authorize(def, approver);
		if (typeof def.approval === 'object' && !can(approver, def.approval.unless)) {
			throw new FamosError('forbidden', `Not allowed to approve ${def.id}`);
		}
		return approver.memberId;
	}

	function mayDecide(draft: DraftRow, actor: Actor): boolean {
		const def = registry.actions.get(draft.action_id);
		if (!def) return false;
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

	async function approveDraft(
		draftId: string,
		approver: Actor,
		editedInput?: unknown,
		options: { auto?: boolean } = {},
	): Promise<DraftRow> {
		const draft = await getDraft(deps.db, draftId);
		assertAddressee(approver, draft);
		if (draft.status === 'applied') return draft; // idempotent
		if (draft.status !== 'pending' && draft.status !== 'failed') {
			throw new FamosError('conflict', `Draft is ${draft.status}`);
		}
		const def = getAction(draft.action_id);
		const approverId = assertApprover(approver, def, draft);
		const input = parseOrThrow(
			def.input,
			editedInput ?? JSON.parse(draft.input),
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
						{ db: view(ownerOf(def.id)).db, family: uow.family, translate: deps.translate },
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
					uow.emit(draftUpdated, { draftId, status: 'rejected' });
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
						edited_input: editedInput === undefined ? null : JSON.stringify(input),
						result: JSON.stringify(output ?? null),
						error: null,
						updated_at: clock.now(),
					})
					.where('id', '=', draftId)
					.execute();
				uow.emit(draftUpdated, { draftId, status: 'applied' });
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
			await bus.publish(draftUpdated.name, { draftId, status: 'failed' });
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
			uow.emit(draftUpdated, { draftId: draft.id, status: 'rejected' });
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
			uow.emit(draftUpdated, { draftId, status: 'rejected' });
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
	): Promise<string | null | undefined> {
		// People see what they pick: nothing to check, and no query unless a draft needs the name.
		if (actor.kind !== 'ai') return undefined;
		const ctx = readContext(def);
		let title: string | null = null;
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
			if (title !== null && !labelNamesTitle(said, title))
				throw new FamosError(
					'conflict',
					`That is '${title}', not '${said}'.${CLOSED_MATTER}`,
					refusal('other_target', said),
				);
		}
		const reason = def.refuseProposal ? await def.refuseProposal(ctx, input) : null;
		if (reason !== null)
			throw new FamosError('conflict', `${reason}${CLOSED_MATTER}`, refusal('settled', title));
		return title;
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
		const input = def.input.safeParse(JSON.parse(draft.input));
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
			// alternative is never the closest thing, whatever the action offering it found.
			const said = subjectOf(JSON.stringify(input));
			if (next.targetTitle && (title === null || !said || !labelNamesTitle(said, title)))
				return null;
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
		const input = def.input.safeParse(JSON.parse(draft.input));
		if (!input.success) return null;
		return alternativeOf(def, input.data, { draftId: draft.id });
	}

	async function currentValues(draft: DraftRow): Promise<Record<string, unknown> | null> {
		if (draft.status !== 'pending' && draft.status !== 'failed') return null;
		const def = registry.actions.get(draft.action_id);
		if (!def?.currentValues || !deps.features.isOn(ownerOf(def.id))) return null;
		// The reviewer reads the draft as it would be approved: with a saved edit when there is one.
		const input = def.input.safeParse(JSON.parse(draft.edited_input ?? draft.input));
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
			const input = def.input.safeParse(JSON.parse(raw));
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
			uow.emit(draftUpdated, { draftId, status: 'pending' });
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
			uow.emit(draftUpdated, { draftId, status: 'undone' });
		});
		return getDraft(deps.db, draftId);
	}

	async function passedCheck(db: DbExecutor = deps.db): Promise<(draft: PassedFacts) => boolean> {
		const { timeZone } = await familyReader(db).settings();
		const today = todayIn(timeZone, clock.now());
		return (draft) =>
			(WAITING_STATUSES as readonly string[]).includes(draft.status) &&
			hasPassed(draftDateOf(registry.actions.get(draft.action_id), draft), today);
	}

	async function expirePassed(): Promise<number> {
		const passed = await passedCheck();
		const waiting = await coreDb()
			.selectFrom('core_drafts')
			.select(['id', 'action_id', 'status', 'input', 'edited_input', 'source_kind', 'source_id'])
			.where('status', 'in', [...WAITING_STATUSES])
			.execute();
		const expired: string[] = [];
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
			expired.push(draft.id);
			for (const memberId of await settleWaitingNotices(deps.db, draft, now))
				await bus.publish(notificationRead.name, { memberId });
		}
		for (const draftId of expired)
			await bus.publish(draftUpdated.name, { draftId, status: 'expired' });
		return expired.length;
	}

	return {
		invoke,
		approveDraft,
		rejectDraft,
		undoDraft,
		undoStep,
		mayExist,
		alternative,
		currentValues,
		subject: subjectOfDraft,
		replaceDraft,
		mayDecide,
		isProposer,
		passedCheck,
		expirePassed,
	};
}
