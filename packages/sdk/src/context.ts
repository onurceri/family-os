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
import type { AiKindInfo, IndexedMention, MentionEnv, SettledResolution } from './understanding.ts';

/** Household-wide settings every extension may read. */
export interface FamilySettings {
	/** What the family is called ("The Novaks"), when it chose a name. */
	name?: string;
	/** IANA time zone used for "today" and recurrence, e.g. `Europe/Istanbul`. */
	timeZone: string;
	/** Default language (a BCP 47 code with a language pack, `en` always) for family-wide content. */
	locale: string;
	/**
	 * The region format, a BCP 47 tag (`en-GB`, `de-DE`): the order of dates, numbers and money;
	 * not the language. Dates and times with words go through `dateLocale(language, formatLocale,
	 * hourCycle)` from `@famos/time`, so their day and month names are in the reader's language.
	 */
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

/**
 * An extension's files. It writes and deletes only keys under `<its id>/`; it reads those, and
 * keys another extension granted it (the papers the Inbox files on a record).
 */
export interface ExtensionFiles extends FileStore {
	/**
	 * Lets another extension read one of this extension's files (`get`, `stat`), for example
	 * before handing its key to that extension's action. Only the owner may grant; granting twice
	 * is harmless. Inside an action, `uow.files.grant` commits with the change.
	 */
	grant(key: string, toExtension: string): Promise<void>;
}

/** Asks family search to (re)read or forget one entity; see `AiIndex`. */
export interface SearchIndexer {
	/** The entity was created or changed: embed it again (changed text only). */
	reindex(kind: string, id: string): Promise<void>;
	/** The entity was deleted: its search entries go. */
	remove(kind: string, id: string): Promise<void>;
}

/**
 * Everything an extension may use, built by the kernel for each extension; there is no
 * DI container. Tests build it with @famos/testing.
 *
 * It is the extension's own view: `db` reaches only tables with its prefix, `files` only its
 * own keys and those granted to it, `secrets` opens only what it sealed, `http` reaches only
 * what its manifest's `network` declares, and `actions.invoke` runs its own actions and those
 * its manifest's `calls` lists. Members and family settings come from `family`.
 */
export interface ExtensionContext {
	/** Only this extension's tables (its `tablePrefix`); anything else throws `forbidden`. */
	readonly db: DbExecutor;
	readonly clock: Clock;
	readonly ids: IdGenerator;
	readonly logger: Logger;
	readonly files: ExtensionFiles;
	/** Seals and opens credentials at rest (see `SecretBox`), with a key of this extension's own. */
	readonly secrets: SecretBox;
	/**
	 * Guarded outbound HTTP (see `ExternalHttp`), limited to the manifest's `network`; use it
	 * from job handlers, or from a route as a bounded read-through (short timeout, size cap,
	 * cached answer, failure as `unavailable`). Slow, repeated or data-changing calls go through a job.
	 */
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
	/**
	 * The transaction, limited to this extension's tables like `ExtensionContext.db`. Use
	 * `db.withTables<MyTables>()` for typing.
	 */
	readonly db: DbExecutor;
	readonly actor: Actor;
	readonly clock: Clock;
	readonly ids: IdGenerator;
	readonly logger: Logger;
	/** This extension's files (see `ExtensionFiles`); grants commit with the transaction. */
	readonly files: ExtensionFiles;
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
	/**
	 * Runs another action inside this transaction, as the same actor. The action gets its own
	 * extension's view of the transaction. Like `actions.invoke`, only this extension's actions
	 * and those its manifest's `calls` lists may be run.
	 */
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
	 * `instead`: the thing already there that the person may change instead when they decide
	 * (its real name, when it is, and the day it would move to), so an agent can tell them.
	 */
	| {
			status: 'drafted';
			draftId: string;
			autoApproval?: true;
			decidedByOthers?: true;
			subject?: string;
			mayExist?: boolean | 'some';
			instead?: {
				name: string;
				at?: { date: string; time?: string };
				to?: { date: string; time?: string };
			};
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
	/**
	 * The words of the shared message the suggestion rests on, exactly as the message writes them,
	 * shown on the card so the person deciding sees where it comes from.
	 */
	quote?: string;
	/** Proposing again with the same key returns the existing draft (idempotent jobs). */
	dedupeKey?: string;
	/**
	 * The member the suggestion is for when the proposer is the AI working for nobody in particular
	 * (the person who shared the item to the Inbox). Auto-approval may act on it; it grants
	 * nothing by itself.
	 */
	forMember?: string;
}

/** An area the AI cannot look into here (see `ActionInvoker.aiMissingAreas`). */
export interface AiMissingArea {
	/** The extension id. */
	id: string;
	/** Its name and what it keeps, in English (prompts are English). */
	name: string;
	description: string;
	/** Not installed, installed but turned off, or closed to the AI. */
	why: 'not_installed' | 'turned_off' | 'closed_to_ai';
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
	 *
	 * An extension may run its own actions and those its manifest's `calls` lists; anything else
	 * is `forbidden`. As an AI actor it may also run what the AI is offered (`aiCatalog`,
	 * `aiReadTools`, `aiContextActions`): that is how the Inbox and the assistant act for the AI.
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
	 * The areas of FamilyOS the AI cannot look into here, so an agent can say so plainly ("Home is
	 * not installed here") instead of reading an empty answer from another area as "there is
	 * none": extensions this server can install that are not installed, installed ones that are
	 * turned off, and areas closed to the AI (off, or local-only when the model is not `local`).
	 */
	aiMissingAreas(options?: { local?: boolean }): AiMissingArea[];
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
	/**
	 * The mention kinds the AI may read in this reading: those of extensions that are on, whose
	 * area is open to the AI (local-only areas only with `local: true`), and whose actions are all
	 * in `aiCatalog` with the same options.
	 */
	aiKinds(options?: { local?: boolean; actor?: Actor }): AiKindInfo[];
	/**
	 * Runs a kind's resolver in its extension's read-only context, for an AI actor only, and only
	 * while the kind is offered to that actor (`aiKinds`, local when `actor.local`); otherwise
	 * `forbidden`. The mentions must all be of the kind, with distinct indexes, at most
	 * `MENTION_LIMIT`. What comes back is held to them: every mention in exactly one resolution,
	 * mentions beyond the kind's `limit` and any a resolver leaves out or claims twice refused as
	 * `incomplete`, and a suggestion of an action the kind does not name refused too. Sorted by
	 * the first mention each comes from. A resolver that fails refuses all its mentions. A
	 * mention a resolver hands to another kind (`handOff`) is resolved by that kind here, when it
	 * is one of the kind's `handsOff` and offered to the actor; otherwise it is refused as
	 * `incomplete`.
	 */
	resolveMentions(
		kindId: string,
		mentions: readonly IndexedMention[],
		env: MentionEnv,
		actor: Actor,
	): Promise<SettledResolution[]>;
}
