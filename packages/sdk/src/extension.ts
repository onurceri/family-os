import type { AnyActionDefinition } from './actions.ts';
import { assertRestrictiveDefaults, type CapabilityDefinition } from './capabilities.ts';
import type { ExtensionContext } from './context.ts';
import type { ConversationProvider } from './conversation.ts';
import type { EventDefinition } from './events.ts';
import type { AnyJobDefinition } from './jobs.ts';
import { type ExtensionManifest, type ExtensionManifestInput, parseManifest } from './manifest.ts';
import type { MentionKindDefinition } from './mention-kinds.ts';
import type { ExtensionMessages } from './messages.ts';
import type { NotificationChannelDefinition } from './notification-channels.ts';
import type { NotificationKindDefinition } from './notifications.ts';
import type { DbExecutor } from './ports.ts';
import type { AnyRouteDefinition } from './routes.ts';
import type { ShareTarget } from './share.ts';

/** A forward-only schema migration. There is no `down`. */
export interface Migration {
	up(db: DbExecutor): Promise<void>;
}

/**
 * Migrations keyed by name. Names sort lexicographically into execution order, so use a
 * zero-padded prefix: `0001_create_items`. Released migrations are never edited.
 */
export type Migrations = Readonly<Record<string, Migration>>;

export interface ExtensionDefinition {
	/** What the extension is and what it reaches, from the `famos` field of its package.json. */
	readonly manifest: ExtensionManifest;
	/** The manifest's id: the namespace of everything it declares and the API path segment. */
	readonly id: string;
	readonly migrations: Migrations;
	readonly actions: readonly AnyActionDefinition[];
	readonly routes: readonly AnyRouteDefinition[];
	readonly jobs: readonly AnyJobDefinition[];
	readonly events: readonly EventDefinition[];
	/** What this extension protects. */
	readonly capabilities: readonly CapabilityDefinition[];
	/** What this extension may tell people; `notify` refuses undeclared kinds. */
	readonly notifications: readonly NotificationKindDefinition[];
	/** Ways it reaches people outside the app; the id is its own or `<id>.<name>`. */
	readonly channels: readonly NotificationChannelDefinition[];
	/**
	 * Holds data the AI should not reach unless the family allows it (health). Its AI
	 * access starts Off instead of Any provider. Only marks; the family decides.
	 */
	readonly sensitive: boolean;
	/**
	 * What the extension tells the AI about its records.
	 * `context` is the id of a read-only action of this extension that returns an
	 * `AiContext`; the Inbox calls it as the AI actor, so a locked area contributes nothing.
	 */
	readonly ai?: AiExtensionHints;
	/** Receives what members share from outside the app; listed in the manifest's `provides`. */
	readonly shareTarget?: ShareTarget;
	/** Answers members who ask from outside the app; listed in the manifest's `provides`. */
	readonly conversation?: ConversationProvider;
	/**
	 * Its texts by language, imported from `src/messages/<code>.json`: `en` and the translations
	 * it ships. The host registers them under the extension's id.
	 */
	readonly messages?: ExtensionMessages;
	/** Optional wiring after all extensions are loaded, e.g. event subscriptions. */
	register?(ctx: ExtensionContext): void | Promise<void>;
}

export interface AiExtensionHints {
	/** One context action, or several when the area has more than one kind of record. */
	context?: string | readonly string[];
	/** What family search may index of this extension. */
	index?: AiIndex;
	/**
	 * What the model may read for this extension from shared messages, and how it is turned into
	 * suggestions (`defineMentionKind`). Ids are `<extension id>.<kind>`.
	 */
	kinds?: readonly MentionKindDefinition[];
}

/** One entity as search reads it: plain text, which core cuts into chunks and embeds. */
export interface AiIndexDocument {
	/** Shown as the result's title; also part of every chunk's text. */
	title: string;
	/** Plain text. Leave out anything the AI should not read (account numbers, serial numbers). */
	text: string;
	/** A path inside the app that opens the entity, for the result's link. */
	href: string;
	/**
	 * Set when this entity needs a capability other than the kind's (an obligation names the
	 * capability of its area as its audience). It must be one the person holds as well, and its
	 * area must be open to the AI, for the AI to find the entity.
	 */
	capability?: string;
	/**
	 * Set when only one member sees the entity (the Inbox item of whoever shared it). Others
	 * see it only if they hold the kind's `viewAll` capability.
	 */
	ownerMemberId?: string | null;
}

export interface AiIndexKind {
	/**
	 * Who may find this kind through search: a member (or the AI acting for them) needs this
	 * capability, whatever the model. Use the capability that lets people see these entities.
	 */
	capability: string;
	/** Members holding this capability also see entities that have an `ownerMemberId`. */
	viewAll?: string;
	/**
	 * Reads one entity from the extension's own tables. Null when it is gone or must not be
	 * indexed (archived, filed, dismissed). Runs in a job, never in a transaction.
	 */
	load(ctx: ExtensionContext, id: string): Promise<AiIndexDocument | null>;
}

export interface AiIndex {
	/**
	 * The kinds of entity, keyed `<extension id>.<kind>` (for example `kitchen.recipe`). Ask
	 * for a (re)index with `uow.ai.reindex(kind, id)` / `ctx.ai.reindex(kind, id)` after every
	 * change and `remove` when the entity is deleted.
	 */
	kinds: Readonly<Record<string, AiIndexKind>>;
	/**
	 * Walks every entity in pages, for rebuilding the index (a model change, an area turned on
	 * again). `cursor` is null for the first page; return `next: null` at the end.
	 */
	list(
		ctx: ExtensionContext,
		cursor: string | null,
	): Promise<{ items: { kind: string; id: string }[]; next: string | null }>;
}

export function defineExtension(definition: {
	/** The `famos` field of the extension's package.json. */
	manifest: ExtensionManifestInput;
	migrations?: Migrations;
	actions?: readonly AnyActionDefinition[];
	routes?: readonly AnyRouteDefinition[];
	jobs?: readonly AnyJobDefinition[];
	events?: readonly EventDefinition[];
	capabilities?: readonly CapabilityDefinition[];
	notifications?: readonly NotificationKindDefinition[];
	channels?: readonly NotificationChannelDefinition[];
	sensitive?: boolean;
	ai?: AiExtensionHints;
	shareTarget?: ShareTarget;
	conversation?: ConversationProvider;
	messages?: ExtensionMessages;
	register?(ctx: ExtensionContext): void | Promise<void>;
}): ExtensionDefinition {
	const manifest = parseManifest(definition.manifest);
	const { id } = manifest;

	const ext: ExtensionDefinition = {
		migrations: {},
		actions: [],
		routes: [],
		jobs: [],
		events: [],
		capabilities: [],
		notifications: [],
		channels: [],
		sensitive: false,
		...definition,
		manifest,
		id,
	};

	const owned = (kind: string, name: string) => {
		if (!name.startsWith(`${id}.`))
			throw new Error(`${kind} "${name}" must be namespaced as "${id}.…"`);
	};
	for (const action of ext.actions) owned('Action', action.id);
	for (const route of ext.routes) owned('Route operationId', route.operationId);
	for (const job of ext.jobs) owned('Job', job.name);
	for (const event of ext.events) owned('Event', event.name);
	for (const kind of ext.notifications) owned('Notification kind', kind.id);
	for (const channel of ext.channels) {
		if (channel.id !== id && !channel.id.startsWith(`${id}.`))
			throw new Error(`Notification channel "${channel.id}" must be "${id}" or "${id}.…"`);
	}
	for (const capability of ext.capabilities) {
		owned('Capability', capability.id);
		assertRestrictiveDefaults(id, capability);
	}
	for (const id of [ext.ai?.context ?? []].flat()) owned('AI context action', id);
	if (ext.shareTarget) owned('Share target capability', ext.shareTarget.requires);
	if (ext.conversation) owned('Conversation capability', ext.conversation.requires);
	for (const kind of Object.keys(ext.ai?.index?.kinds ?? {})) owned('AI index kind', kind);
	for (const kind of ext.ai?.kinds ?? []) owned('Mention kind', kind.id);
	return ext;
}
