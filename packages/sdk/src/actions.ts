import { z } from 'zod';
import type { Actor } from './actor.ts';
import type { ExtensionContext, UnitOfWork } from './context.ts';

/** What a duplicate check may read. */
export type DuplicateContext = Pick<ExtensionContext, 'db' | 'family' | 'translate'>;

/**
 * Approval policy for an action:
 * - 'never': always applied directly (still subject to RBAC).
 * - 'always': always becomes a draft that a human approves.
 * - 'ai': becomes a draft when the caller is AI (the default for non-read-only actions).
 * - `{ unless }`: people without the capability propose a draft instead.
 * - a function: custom decision; combine it with `requires`.
 */
export type ApprovalPolicy<I> =
	| 'never'
	| 'always'
	| 'ai'
	/**
	 * Applied directly by people with the capability (and in the `except` case); proposed as a
	 * draft by others who may propose (`core.drafts.propose`). Approving needs the capability.
	 */
	| { unless: string; except?: (actor: Actor, input: I) => boolean }
	| ((actor: Actor, input: I, can: (capability: string) => boolean) => boolean);

export interface ActionDefinition<
	Id extends string = string,
	In extends z.ZodType = z.ZodType,
	Out extends z.ZodType = z.ZodType,
> {
	readonly id: Id;
	readonly title: string;
	/**
	 * i18n key (in the owning extension's catalog) naming what a draft of this action proposes
	 * ("Remove a service entry"). It titles the draft where no presenter or summary does, and the
	 * "waiting" notification. Every action that can become a draft declares one: `title` is
	 * English and for developers only.
	 */
	readonly draftTitle?: string;
	readonly description?: string;
	readonly input: In;
	readonly output: Out;
	/** Read-only actions never create drafts and are safe for AI to call. */
	readonly readOnly: boolean;
	/**
	 * Capability needed to invoke this action at all. A non-read-only action declares
	 * `requires`, `approval: { unless }`, or both.
	 */
	readonly requires?: string;
	readonly approval: ApprovalPolicy<z.infer<In>>;
	/**
	 * Set when AI may use this action: a data-changing one is proposed as a draft (a draft tool of
	 * the assistant, and an Inbox proposal); a read-only one becomes a read tool. Read
	 * tools return handles, never ids, in what the model reads: the host maps ids to handles.
	 */
	readonly ai?: ActionAiHints;
	/**
	 * Marks an action that sends data outside the household (a message, an email, a call to a
	 * third party, a share link). The registry refuses `ai` hints on it, so the AI can never
	 * propose it.
	 */
	readonly external?: boolean;
	/**
	 * Opts in to auto-approval: a manager may choose that drafts of this action are
	 * approved at once when their proposer holds one of these capabilities. The first is the default.
	 */
	readonly autoApprove?: AutoApprovalHints;
	/**
	 * The web app may queue this action while offline and send it later. Only for
	 * actions that are idempotent for a repeated request key and still meaningful when applied
	 * minutes later (ticking an item, completing a task); everything else needs a connection.
	 */
	readonly offline?: boolean;
	/**
	 * How to take back an applied draft of this action ("Undo" after approving): the inverse
	 * action and its input, computed from this action's output. Null when nothing can be undone.
	 */
	readonly undo?: (output: z.infer<Out>) => UndoStep | null;
	/**
	 * Whether what a pending draft proposes seems to exist already (same title and date, say), so
	 * the reviewer sees "this may already be there". Read-only and cheap; a hint, never a block.
	 * Answer `'some'` when a draft carries several things and only part of them exist.
	 */
	readonly alreadyThere?: (ctx: DuplicateContext, input: z.infer<In>) => Promise<boolean | 'some'>;
	/**
	 * What a pending draft could do to a thing already on record instead of adding a second one:
	 * a new event whose title names an event already on the calendar is offered as a change of that
	 * event (news that it moved arrives with the new date). The reviewer chooses; the draft then
	 * becomes a draft of that action, decided like any other. Null when nothing fits. It must name
	 * one thing by words of its title, never the closest one. Read-only and cheap.
	 */
	readonly instead?: (
		ctx: DuplicateContext,
		input: z.infer<In>,
	) => Promise<DraftAlternative | null>;
	/**
	 * The real title of the thing an input with a `label` points at (null when it is not there).
	 * An AI must send the `label` (the name the person used for the thing, in their words) and
	 * every significant word of it must be a word of the real title; otherwise the runner refuses
	 * with the real title, so a model that picked the closest thing instead of the named one tells
	 * the person it is not there. Every draft of the action is stored with the real title as its
	 * `label`, so reviewers see what will really change. Read-only and cheap.
	 */
	readonly targetTitle?: (ctx: DuplicateContext, input: z.infer<In>) => Promise<string | null>;
	/**
	 * A qualifier for an input that changes only part of what the title names: one date of a
	 * repeating event. `key` is a catalog key (in the extension's catalog) that takes `{{date}}`;
	 * `date` is a day (YYYY-MM-DD) the host writes in the family's format locale. Null when the
	 * input is not partial, so the title stands for the whole.
	 */
	readonly scopeNote?: (
		ctx: DuplicateContext,
		input: z.infer<In>,
	) => Promise<{ key: string; date: string } | null>;
	/**
	 * A reason an AI's proposal is pointless (the thing is already in the state it asks for), or
	 * null. The runner refuses the proposal with that text, so the model tells the person instead
	 * of filling the review list with changes that change nothing. Only asked of AI actors.
	 * Read-only and cheap.
	 */
	readonly refuseProposal?: (ctx: DuplicateContext, input: z.infer<In>) => Promise<string | null>;
	/**
	 * Turns a thing the caller named in words (a shopping list by its name) into the id the action
	 * works with, before anything else looks at the input. It throws a `bad_request` that says what
	 * is wrong and what the valid names are, so a model can correct itself. Read-only and cheap.
	 */
	readonly resolveNames?: (ctx: DuplicateContext, input: z.infer<In>) => Promise<z.infer<In>>;
	/**
	 * Whether what the input asks for is already so (a shopping item already ticked, a task
	 * already done). Approving a pending draft whose input is settled closes it as "already
	 * done" instead of running it, so nothing is recorded as applied that changed nothing and no
	 * undo is offered for it (an undo would reverse somebody else's real change). Read-only and
	 * cheap; it runs inside the approval's transaction.
	 */
	readonly settled?: (ctx: DuplicateContext, input: z.infer<In>) => Promise<boolean>;
	/**
	 * The day a draft of this action is about (`YYYY-MM-DD`, family time), when it is about one.
	 * Once that day has passed in the family's time zone the suggestion means nothing any more:
	 * it is no longer shown as waiting and expires by itself. Undefined (or no function) when
	 * it never expires: a task that is late is still worth doing, a repeating event still comes.
	 */
	readonly draftDate?: (input: z.infer<In>) => string | undefined;
	/**
	 * Work that must happen outside the transaction, before `run` (a unit of work holds the one
	 * database connection, so nothing slow or networked may happen inside it). Runs after the
	 * permission checks and input validation; its result is the third argument of `run`. It is
	 * skipped when the action runs inside another unit of work (`uow.run`).
	 */
	readonly prepare?: (input: z.infer<In>, actor: Actor) => Promise<unknown>;
	run(uow: UnitOfWork, input: z.infer<In>, prepared?: unknown): Promise<z.infer<Out>>;
}

/**
 * Lets the AI pipeline propose this action. The description is shown to the model next to the
 * input's JSON Schema, so write it for a model: what the action does and when to choose it.
 */
export interface UndoStep {
	actionId: string;
	input: unknown;
}

/**
 * Another action a pending draft could become (`ActionDefinition.instead`). `at` says when the
 * thing already there is (a day, and a time when it has one), so the reviewer can tell which one
 * it is.
 */
export interface DraftAlternative {
	actionId: string;
	input: unknown;
	at?: { date: string; time?: string };
}

export interface AutoApprovalHints {
	/** i18n key naming what is approved ("Shopping items"), shown in More → Auto-approval. */
	readonly label: string;
	/** The capabilities a proposer may be required to hold; the first is the default. */
	readonly capabilities: readonly [string, ...string[]];
}

export interface ActionAiHints {
	description: string;
	/** Short guidance for filling fields, e.g. how to pick members or dates. */
	guidance?: string;
	/**
	 * Offered only to the in-app assistant working for a member, not to the Inbox pipeline that
	 * reads shared (untrusted) content, nor to MCP clients: for actions that should come from a
	 * person's own request here.
	 */
	assistantOnly?: boolean;
	/**
	 * What the assistant proposes becomes a draft addressed to the member it works for: only that
	 * member sees and decides it (not other approvers, admins included). For personal things whose
	 * text is private, or whose approval acts as the member.
	 */
	addressToMember?: boolean;
}

const ACTION_ID = /^[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9]*$/;

export function defineAction<
	const Id extends string,
	In extends z.ZodType,
	Out extends z.ZodType,
	Prepared = undefined,
>(definition: {
	id: Id;
	title: string;
	draftTitle?: string;
	description?: string;
	input: In;
	output: Out;
	readOnly?: boolean;
	requires?: string;
	approval?: ApprovalPolicy<z.infer<In>>;
	ai?: ActionAiHints;
	external?: boolean;
	autoApprove?: AutoApprovalHints;
	offline?: boolean;
	undo?: (output: z.infer<Out>) => UndoStep | null;
	alreadyThere?: (ctx: DuplicateContext, input: z.infer<In>) => Promise<boolean | 'some'>;
	instead?: (ctx: DuplicateContext, input: z.infer<In>) => Promise<DraftAlternative | null>;
	targetTitle?: (ctx: DuplicateContext, input: z.infer<In>) => Promise<string | null>;
	scopeNote?: (
		ctx: DuplicateContext,
		input: z.infer<In>,
	) => Promise<{ key: string; date: string } | null>;
	refuseProposal?: (ctx: DuplicateContext, input: z.infer<In>) => Promise<string | null>;
	resolveNames?: (ctx: DuplicateContext, input: z.infer<In>) => Promise<z.infer<In>>;
	settled?: (ctx: DuplicateContext, input: z.infer<In>) => Promise<boolean>;
	draftDate?: (input: z.infer<In>) => string | undefined;
	prepare?: (input: z.infer<In>, actor: Actor) => Promise<Prepared>;
	run(uow: UnitOfWork, input: z.infer<In>, prepared: Prepared): Promise<z.infer<Out>>;
}): ActionDefinition<Id, In, Out> {
	if (!ACTION_ID.test(definition.id)) {
		throw new Error(
			`Invalid action id "${definition.id}": use "<extension>.<verbNoun>", e.g. "shopping.addItem"`,
		);
	}
	const readOnly = definition.readOnly ?? false;
	return {
		...definition,
		readOnly,
		approval: definition.approval ?? (readOnly ? 'never' : 'ai'),
	} as ActionDefinition<Id, In, Out>;
}

// biome-ignore lint/suspicious/noExplicitAny: registries hold heterogeneous action types.
export type AnyActionDefinition = ActionDefinition<string, any, any>;

/**
 * What an extension's `ai.context` action returns: the records the model may refer to when
 * proposing changes (vehicles, pets, open obligations…). Ids are for code only; the Inbox shows
 * the model short handles (`vehicle:1`) and maps them back.
 */
export const AiContextSchema = z.object({
	/** What the items are, singular and lowercase: `vehicle`. Becomes the handle prefix. */
	kind: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/),
	/** A heading for the model: `Vehicles`. */
	label: z.string().min(1).max(60),
	/**
	 * The items are words the model writes as they are (the family's tags), not records: they get
	 * no handles, and no proposal refers to them by id.
	 */
	plain: z.literal(true).optional(),
	items: z
		.array(
			z.object({
				id: z.string().min(1).max(120),
				label: z.string().min(1).max(160),
				details: z.string().max(400).optional(),
				/** A path inside the app that opens the item; filled into `recordUrl` of proposals. */
				url: z.string().max(300).optional(),
			}),
		)
		.max(200),
});
export type AiContext = z.infer<typeof AiContextSchema>;
