import type {
	ActionResult,
	Actor,
	Clock,
	DbExecutor,
	DraftAlternative,
	DraftMeta,
	ExtensionFiles,
	IdGenerator,
	JobQueue,
	Logger,
	SecretBox,
	UndoStep,
	UnitOfWork,
} from '@famos/sdk';
import type { Access } from '../access.ts';
import type { Decision } from '../decide.ts';
import type { InProcessEventBus } from '../event-bus.ts';
import type { Features } from '../features.ts';
import type { Notifier } from '../notifications.ts';
import type { Registry } from '../registry.ts';
import type { DraftRow } from '../tables.ts';

export type { DraftMeta };

export interface InvokeOptions {
	/** Metadata stored on the draft if the action ends up needing approval. */
	draft?: DraftMeta;
	/**
	 * A client-chosen request key (a member or an AI agent; keys are kept per caller). The same
	 * key for the same action returns the stored result without running anything again; the key
	 * is stored in the action's own transaction.
	 */
	idempotencyKey?: string;
	/** Called when the result came from a stored key instead of a new run. */
	onReplay?: () => void;
	/**
	 * The extension that asks (through its context). It may run its own actions and those its
	 * manifest's `calls` lists, or as an AI actor what the AI is offered. Left out: the host.
	 */
	caller?: string;
	/**
	 * The version of the thing the caller read (the `versionColumn` of the action's `target`). When
	 * the row has moved on, the action is refused with `precondition_failed` and nothing changes;
	 * the check and the write share one transaction, so two callers cannot both win.
	 */
	ifMatch?: number;
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
	/**
	 * One transaction for an extension's own writes outside an action (a job): events emitted in
	 * it are kept in the change log with the data and fire after the commit.
	 */
	unit<T>(extensionId: string, work: (uow: UnitOfWork) => Promise<T>): Promise<T>;
	/** Takes back an applied draft with its action's inverse, in one transaction. */
	undoDraft(draftId: string, approver: Actor): Promise<DraftRow>;
	/**
	 * Sends an undone draft again as a new waiting one, for the person behind it: the change it
	 * applied, with the same source and notes, decided like any other. Once per undone draft.
	 */
	suggestAgain(draftId: string, actor: Actor): Promise<DraftRow>;
	/** Whether an undone draft was suggested again already. */
	suggestedAgain(draft: DraftRow): Promise<boolean>;
	/** The connected app or AI app a draft came through, by its current name, or null. */
	appBehind(
		draft: DraftRow,
	): Promise<{ id: string; name: string; kind: 'connected' | 'ai' } | null>;
	/** The inverse step of an applied draft, or null when it cannot be undone. */
	undoStep(draft: Pick<DraftRow, 'action_id' | 'status' | 'result'>): UndoStep | null;
	/** Whether this actor could decide the draft: it is theirs, or they are an approver for it. */
	mayDecide(draft: DeciderFacts, actor: Actor): boolean;
	/**
	 * The suggestions still waiting that this caller sees, newest first (oldest first with
	 * `oldestFirst`): a person as they are in the app sees their own and those they may decide, any
	 * other caller only what it made itself (an app acting for a member sees that member's view
	 * within what it may do). One about a day that has passed, or about something that is gone, no
	 * longer waits. `decidableOnly` keeps only those the actor may decide now, `statuses` narrows
	 * the waiting states, and `about` narrows to one draft or to the drafts of one source.
	 */
	waitingFor(
		actor: Actor,
		options?: {
			statuses?: readonly ('pending' | 'failed')[];
			about?: { draftId: string } | { sourceKind: string; sourceId: string };
			decidableOnly?: boolean;
			oldestFirst?: boolean;
		},
	): Promise<DraftRow[]>;
	/** Whether this caller sees a suggestion (the rule `waitingFor` applies to each row). */
	draftVisibleTo(actor: Actor, draft: DraftRow): boolean;
	/** The ids among these suggestions that this caller sees; none when it may not propose. */
	visibleDraftIds(actor: Actor, ids: readonly string[]): Promise<Set<string>>;
	/** Whether this actor is the member behind the draft (who proposed it, or who the AI proposed it for). */
	isProposer(actor: Actor, draft: DraftRow): boolean;
	/**
	 * Why nobody can decide a waiting draft right now: the extension its action belongs to is not
	 * installed, or is turned off. Null when its action runs. The draft is kept: a reinstall (or
	 * switching the extension on) brings it back as an ordinary waiting suggestion.
	 */
	unavailable(draft: Pick<DraftRow, 'action_id'>): DraftUnavailable | null;
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
	goneAmong(drafts: readonly GoneFacts[], db?: DbExecutor): Promise<ReadonlySet<string>>;
	/** Marks every waiting draft whose day has passed `expired`. Idempotent; returns how many. */
	expirePassed(): Promise<number>;
}

/** What `passedCheck` needs of a draft. */
export type PassedFacts = Pick<DraftRow, 'action_id' | 'status' | 'input' | 'edited_input'>;
/** What `mayDecide` needs of a draft. */
export type DeciderFacts = Pick<DraftRow, 'id' | 'action_id' | 'for_member'>;
/** What `goneAmong` needs of a draft. */
export type GoneFacts = PassedFacts & Pick<DraftRow, 'id'>;
