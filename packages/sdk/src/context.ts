import type { Actor } from './actor.ts';
import type { AccessControl } from './capabilities.ts';
import type { EventBus, EventEmitter } from './events.ts';
import type { NotifyRequest } from './notifications.ts';
import type {
	Clock,
	DbExecutor,
	EnqueueOptions,
	ExternalHttp,
	FileStore,
	IdGenerator,
	Logger,
	SecretBox,
} from './ports.ts';

/** Household-wide settings every extension may read. */
export interface FamilySettings {
	/** IANA time zone used for "today" and recurrence, e.g. `Europe/Istanbul`. */
	timeZone: string;
	/** Default language (a BCP 47 code with a language pack, `en` always) for family-wide content. */
	locale: string;
	/** BCP 47 tag that formats dates, times, numbers and money (`en-GB`, `de-DE`); not the language. */
	formatLocale: string;
	/** First day of the week, ISO: 1 = Monday … 7 = Sunday. */
	weekStart: number;
	/** 12-hour (`h12`) or 24-hour (`h23`) clock. */
	hourCycle: 'h12' | 'h23';
	temperatureUnit: 'celsius' | 'fahrenheit';
}

/** An active family member as other modules may see it (no credentials). */
export interface FamilyMember {
	id: string;
	displayName: string;
	roleId: string;
	color: string;
	/** Free text about the person ("9 years old, at primary school"), for context; no security meaning. */
	about: string | null;
	/** The person's own language (a BCP 47 code with a language pack), or null for the family's. */
	locale: string | null;
}

export interface FamilyReader {
	settings(): Promise<FamilySettings>;
	/** Active (not archived) members. Extensions reference members only by these IDs. */
	members(): Promise<FamilyMember[]>;
}

/** Asks family search to (re)read or forget one entity; see `AiIndex`. */
export interface SearchIndexer {
	/** The entity was created or changed: embed it again (changed text only). */
	reindex(kind: string, id: string): Promise<void>;
	/** The entity was deleted: its search entries go. */
	remove(kind: string, id: string): Promise<void>;
}

/**
 * Everything an extension may use. Built once by the composition root; there is no
 * DI container. Tests build it with @famos/testing.
 */
export interface ExtensionContext {
	readonly db: DbExecutor;
	readonly clock: Clock;
	readonly ids: IdGenerator;
	readonly logger: Logger;
	readonly files: FileStore;
	/** Seals and opens credentials at rest (see `SecretBox`). */
	readonly secrets: SecretBox;
	/** Guarded outbound HTTP (see `ExternalHttp`); use it from job handlers only. */
	readonly http: ExternalHttp;
	readonly events: EventBus;
	readonly actions: ActionInvoker;
	readonly family: FamilyReader;
	/**
	 * Renders a translation key (`assistant:busy`, namespace = extension id) in a
	 * language, for text that is stored or sent rather than shown through the UI. English when
	 * the language or string is missing.
	 */
	translate(locale: string, key: string, params?: Record<string, unknown>): string;
	/**
	 * The words or phrases a translation key lists (comma-separated), in English and in every
	 * installed language pack, lower-cased and without repeats: for recognizing what people type in
	 * any of the family's languages. Code never holds words of a language; packs bring them
	 *.
	 */
	vocabulary(key: string): readonly string[];
	/** Capability checks, e.g. to show supervised members only their own items. */
	readonly access: AccessControl;
	/**
	 * Family search, from a job or an event handler: enqueues the indexing right away.
	 * Inside an action use `uow.ai`, which commits with the change.
	 */
	readonly ai: SearchIndexer;
	/**
	 * Tells people something, from a job or a route: enqueues a `core.notify` job right
	 * away. Inside an action use `uow.notify`, which commits together with the data change.
	 * Throws for an undeclared kind or an unknown capability.
	 */
	notify(request: NotifyRequest): Promise<void>;
	/**
	 * Enqueues a job right away, for follow-up work from inside a job (for example the next
	 * reminder of a series). Inside an action use `uow.enqueue`, which commits with the change.
	 */
	enqueue(job: string, payload: unknown, options?: EnqueueOptions): Promise<string>;
}

/** A unit of work: one SQLite transaction, with jobs and events bound to it. */
export interface UnitOfWork extends EventEmitter {
	/** The transaction. Use `db.withTables<MyTables>()` for typing. */
	readonly db: DbExecutor;
	readonly actor: Actor;
	readonly clock: Clock;
	readonly ids: IdGenerator;
	readonly logger: Logger;
	readonly files: FileStore;
	/** Seals and opens credentials at rest (see `SecretBox`). */
	readonly secrets: SecretBox;
	readonly family: FamilyReader;
	/** Renders a translation key in a language (see `ExtensionContext.translate`). */
	translate(locale: string, key: string, params?: Record<string, unknown>): string;
	/** The words a key lists in every installed language (see `ExtensionContext.vocabulary`). */
	vocabulary(key: string): readonly string[];
	/** Family search: the indexing is enqueued in this transaction. */
	readonly ai: SearchIndexer;
	/** Whether this unit of work's actor holds a capability. */
	can(capability: string): boolean;
	/** Enqueues a job in the same transaction (the queue is the outbox). */
	enqueue(job: string, payload: unknown, options?: EnqueueOptions): Promise<string>;
	/**
	 * Tells people something: enqueues a `core.notify` job in this transaction, so the
	 * notification exists only if the change commits. Recipients are resolved when the job runs.
	 * Throws for an undeclared kind or an unknown capability.
	 */
	notify(request: NotifyRequest): Promise<void>;
	/**
	 * Rejects the waiting suggestions (pending or failed drafts) that came from a source, in this
	 * transaction. For an extension that removes the thing they were made from; the caller has
	 * already passed its own permission check. Returns how many were rejected.
	 */
	rejectDraftsOf(source: { kind: string; id: string }): Promise<number>;
	/** Runs another action inside this transaction, as the same actor. */
	run<I, O>(actionId: string, input: I): Promise<O>;
}

export type ActionResult<O> =
	| { status: 'applied'; output: O }
	/**
	 * `autoApproval`: a job approves the draft in a moment, nobody needs to. `decidedByOthers`:
	 * the person the AI works for cannot decide it, so other members who can approve do.
	 * `subject`: what the stored suggestion is about, in its stored words (the real title of an
	 * existing item, not the proposer's name for it); absent when it names nothing.
	 * `mayExist`: the action's `alreadyThere` thinks what was proposed is on record already.
	 */
	| {
			status: 'drafted';
			draftId: string;
			autoApproval?: true;
			decidedByOthers?: true;
			subject?: string;
			mayExist?: boolean | 'some';
	  };

/** Stored on a draft when an action is proposed rather than applied. */
export interface DraftMeta {
	sourceKind?: string;
	sourceId?: string;
	summary?: string;
	model?: string;
	promptVersion?: string;
	confidence?: number;
	/** Input fields the proposer is unsure about (dot paths), shown as "check this". */
	uncertainFields?: string[];
	/** Proposing again with the same key returns the existing draft (idempotent jobs). */
	dedupeKey?: string;
	/**
	 * The member the suggestion is for when the proposer is the AI working for nobody in particular
	 * (the person who shared the item to the Inbox). Auto-approval may act on it; it grants
	 * nothing by itself.
	 */
	forMember?: string;
}

/** An action AI may propose, with its input as JSON Schema (for the model). */
export interface AiActionInfo {
	id: string;
	title: string;
	description: string;
	/** Catalog key of the action's name as a suggestion (`defineAction`'s `draftTitle`). */
	draftTitle?: string;
	guidance?: string;
	inputSchema: Record<string, unknown>;
}

export interface ActionInvoker {
	/**
	 * Runs an action through the action runner: validation → RBAC → approval policy →
	 * transaction → audit → events. May return a draft instead of applying.
	 */
	invoke<O = unknown>(
		actionId: string,
		input: unknown,
		actor: Actor,
		options?: { draft?: DraftMeta },
	): Promise<ActionResult<O>>;
	/**
	 * Actions marked `ai`, for the AI pipeline. Actions of areas that are off for the AI never
	 * appear; those of local-only areas appear only with `local: true` (the model that will see
	 * the catalog runs on the family's network). Read-only actions are not in it (see
	 * `aiReadTools`). With an `actor` (an AI actor on behalf of a member) only actions that member
	 * may propose are listed.
	 */
	aiCatalog(options?: { local?: boolean; actor?: Actor }): AiActionInfo[];
	/**
	 * Read-only actions marked `ai` (read tools of the assistant), filtered like
	 * `aiCatalog`. With an `actor` (an AI actor on behalf of a member) only the actions that actor
	 * may run are listed: the agent never sees more than the person asking.
	 */
	aiReadTools(options?: { local?: boolean; actor?: Actor }): AiActionInfo[];
	/**
	 * Extensions (turned on) that declare an `ai.context` action: extension id → action ids. The
	 * caller invokes it as the AI actor, which refuses areas that are off for the AI.
	 */
	aiContextActions(): ReadonlyMap<string, readonly string[]>;
	/**
	 * What an action's input schema rejects in `input` (`path: message` lines), without running
	 * anything; empty when the input is valid or the action is unknown. For the AI pipeline, to
	 * tell a model what to fix before anything is drafted.
	 */
	checkInput(actionId: string, input: unknown): string[];
	/**
	 * The real title of the existing thing an input points at, for actions that declare
	 * `targetTitle`; null when the action has none, the input is invalid or the target is gone.
	 * Runs no change. For the AI pipeline, to check a proposal against what the person wrote.
	 */
	targetTitle(actionId: string, input: unknown): Promise<string | null>;
}
