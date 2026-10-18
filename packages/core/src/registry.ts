import type {
	AnyActionDefinition,
	AnyJobDefinition,
	AnyRouteDefinition,
	CapabilityDefinition,
	ConversationProvider,
	EventDefinition,
	ExtensionDefinition,
	HostContract,
	NotificationKindDefinition,
	QuestionTopic,
	ShareTarget,
} from '@famos/sdk';
import {
	assertRestrictiveDefaults,
	DigestInputSchema,
	DigestOutputSchema,
	mentionKindProblems,
	QUESTION_TOPICS,
	reservedClash,
	SDK_VERSION,
	satisfiesCaret,
	tablePrefixOf,
} from '@famos/sdk';
import type { ExtensionProblem } from './extension-state.ts';

export interface Registry {
	/** Extensions in dependency order (dependencies first). */
	readonly extensions: readonly ExtensionDefinition[];
	readonly actions: ReadonlyMap<string, AnyActionDefinition>;
	readonly jobs: ReadonlyMap<string, AnyJobDefinition>;
	readonly events: ReadonlyMap<string, EventDefinition>;
	readonly routes: readonly { extension: string; route: AnyRouteDefinition }[];
	/** All capabilities, core's first. */
	readonly capabilities: readonly CapabilityDefinition[];
	/** All notification kinds by id, core's first. */
	readonly notificationKinds: ReadonlyMap<string, NotificationKindDefinition>;
	/** The extension that receives what members share from outside the app, if one is installed. */
	readonly shareTarget: { readonly extension: string; readonly target: ShareTarget } | null;
	/** The extension that answers what members ask from outside the app, if one is installed. */
	readonly conversation: {
		readonly extension: string;
		readonly provider: ConversationProvider;
	} | null;
}

const ROUTE_ACCESS = new Set(['public', 'trusted-device', 'signedIn']);

const REFUSED = Symbol.for('famos.ExtensionRefusedError');

/**
 * An extension the registry cannot take, and why: its manifest disagrees with its code, or it
 * clashes with what another extension or the host already holds. The kernel leaves out an
 * extension that may be refused (one that is not always installed) and starts without it.
 */
export class ExtensionRefusedError extends Error {
	readonly [REFUSED] = true;
	readonly extensionId: string;
	readonly reason: string;
	/** What a page says about it (see `EXTENSION_PROBLEMS`); `invalid` unless more is known. */
	readonly code: ExtensionProblem;
	readonly params: Record<string, string> | undefined;

	constructor(
		extensionId: string,
		reason: string,
		code: ExtensionProblem = 'invalid',
		params?: Record<string, string>,
	) {
		super(reason);
		this.name = 'ExtensionRefusedError';
		this.extensionId = extensionId;
		this.reason = reason;
		this.code = code;
		this.params = params;
	}
}

export const isExtensionRefusedError = (error: unknown): error is ExtensionRefusedError =>
	typeof error === 'object' &&
	error !== null &&
	(error as Record<symbol, unknown>)[REFUSED] === true;

function refuse(
	extensionId: string,
	reason: string,
	code?: ExtensionProblem,
	params?: Record<string, string>,
): never {
	throw new ExtensionRefusedError(extensionId, reason, code, params);
}

/** Orders extensions so that every extension comes after its dependencies. */
export function orderExtensions(extensions: readonly ExtensionDefinition[]): ExtensionDefinition[] {
	const byId = new Map<string, ExtensionDefinition>();
	for (const ext of extensions) {
		if (byId.has(ext.id)) refuse(ext.id, `Duplicate extension id "${ext.id}"`, 'name_clash');
		byId.set(ext.id, ext);
	}
	const ordered: ExtensionDefinition[] = [];
	const state = new Map<string, 'visiting' | 'done'>();
	const visit = (ext: ExtensionDefinition, path: string[]) => {
		const s = state.get(ext.id);
		if (s === 'done') return;
		if (s === 'visiting')
			refuse(ext.id, `Extension dependency cycle: ${[...path, ext.id].join(' → ')}`);
		state.set(ext.id, 'visiting');
		for (const dep of ext.manifest.dependsOn) {
			const target = byId.get(dep);
			if (!target)
				return refuse(
					ext.id,
					`Extension "${ext.id}" depends on missing extension "${dep}"`,
					'missing_dependency',
					{ extensionId: dep },
				);
			visit(target, [...path, ext.id]);
		}
		state.set(ext.id, 'done');
		ordered.push(ext);
	};
	for (const ext of [...extensions].sort((a, b) => a.id.localeCompare(b.id))) visit(ext, []);
	return ordered;
}

/**
 * Checks each manifest against the code and against the other extensions: the manifest is what
 * the host can read before an extension runs, so it must say all of what the code does.
 */
function checkManifests(
	ordered: readonly ExtensionDefinition[],
	actions: ReadonlyMap<string, AnyActionDefinition>,
): void {
	const present = new Set(ordered.map((ext) => ext.id));
	const prefixes: { id: string; prefix: string }[] = [];
	for (const ext of ordered) {
		const { manifest } = ext;
		const where = `Extension "${ext.id}"`;
		if (manifest.id !== ext.id) refuse(ext.id, `${where} carries the manifest of "${manifest.id}"`);
		if (!satisfiesCaret(SDK_VERSION, manifest.sdk))
			refuse(
				ext.id,
				`${where} needs SDK ${manifest.sdk}, but this host has ${SDK_VERSION}`,
				'sdk',
				{
					needs: manifest.sdk,
					has: SDK_VERSION,
				},
			);

		for (const dep of manifest.dependsOn) {
			if (manifest.optional.includes(dep))
				refuse(ext.id, `${where} names "${dep}" both as a dependency and as optional`);
		}

		const declared = new Set(manifest.capabilities);
		const inCode = new Set(ext.capabilities.map((c) => c.id));
		const unlisted = [...inCode].filter((id) => !declared.has(id));
		const absent = [...declared].filter((id) => !inCode.has(id));
		if (unlisted.length)
			refuse(ext.id, `${where} declares capabilities its manifest lacks: ${unlisted.join(', ')}`);
		if (absent.length)
			refuse(ext.id, `${where} lists capabilities its code lacks: ${absent.join(', ')}`);

		const implemented: Record<HostContract, boolean> = {
			shareTarget: ext.shareTarget !== undefined,
			conversation: ext.conversation !== undefined,
		};
		for (const [contract, inCode] of Object.entries(implemented)) {
			const listed = manifest.provides.includes(contract as HostContract);
			if (inCode && !listed)
				refuse(ext.id, `${where} implements ${contract}, which its manifest's provides lacks`);
			if (listed && !inCode)
				refuse(ext.id, `${where} lists ${contract} in provides, but its code lacks it`);
		}

		const prefix = tablePrefixOf(manifest);
		// Core is the host itself and owns `core_`.
		const clash = ext.id === 'core' ? null : reservedClash(ext.id, prefix);
		if (clash) refuse(ext.id, `${where} cannot be installed: ${clash}`, 'name_clash');
		for (const other of prefixes) {
			if (prefix.startsWith(other.prefix) || other.prefix.startsWith(prefix))
				refuse(
					ext.id,
					`${where} and "${other.id}" have overlapping table prefixes "${prefix}" and "${other.prefix}"`,
					'name_clash',
				);
		}
		prefixes.push({ id: ext.id, prefix });

		for (const call of manifest.calls) {
			const owner = call.slice(0, call.indexOf('.'));
			if (owner === ext.id)
				refuse(ext.id, `${where} lists its own action "${call}" in calls; list only foreign ones`);
			const reachable =
				owner === 'core' || manifest.dependsOn.includes(owner) || manifest.optional.includes(owner);
			if (!reachable)
				refuse(
					ext.id,
					`${where} calls "${call}", but "${owner}" is neither a dependency nor optional`,
				);
			// An optional extension that is not installed has no actions to check.
			if (present.has(owner) && !actions.has(call))
				refuse(ext.id, `${where} calls "${call}", which "${owner}" does not have`);
		}
	}
}

/**
 * An extension's mention kinds: well formed (`mentionKindProblems`), each id once, suggesting only
 * AI-proposable actions it owns or lists in `calls`, handing mentions only to kinds of
 * extensions its manifest names, and showing names only from its own AI context actions.
 */
function checkMentionKinds(
	ext: ExtensionDefinition,
	actions: ReadonlyMap<string, AnyActionDefinition>,
): void {
	const kinds = ext.ai?.kinds ?? [];
	const contexts = new Set([ext.ai?.context ?? []].flat());
	const seen = new Set<string>();
	for (const kind of kinds) {
		const where = `Mention kind "${kind.id}"`;
		if (seen.has(kind.id)) refuse(ext.id, `Duplicate mention kind "${kind.id}"`);
		seen.add(kind.id);
		const [problem] = mentionKindProblems(ext.id, kind, kinds);
		if (problem) refuse(ext.id, problem);
		for (const id of kind.actions) {
			const own = id.startsWith(`${ext.id}.`);
			if (!own && !ext.manifest.calls.includes(id))
				refuse(
					ext.id,
					`${where} names "${id}", which is neither its own nor in its manifest's calls`,
				);
			const action = actions.get(id);
			if (own && (!action || !ext.actions.includes(action)))
				refuse(ext.id, `${where} names action "${id}", which "${ext.id}" lacks`);
			// A foreign action is checked once its extension is there; `calls` says it must exist.
			if (action && (action.readOnly || !action.ai))
				refuse(ext.id, `${where} names "${id}", which the AI cannot propose`);
		}
		for (const id of kind.handsOff ?? []) {
			const owner = id.slice(0, id.indexOf('.'));
			if (!ext.manifest.dependsOn.includes(owner) && !ext.manifest.optional.includes(owner))
				refuse(
					ext.id,
					`${where} hands mentions to "${id}", but "${owner}" is neither a dependency nor optional`,
				);
		}
		for (const id of kind.knownFrom ?? [])
			if (!contexts.has(id))
				refuse(
					ext.id,
					`${where} shows names from "${id}", which is not one of its AI context actions`,
				);
	}
}

/** Collects all contributions and rejects duplicates across extensions. */
export function buildRegistry(
	extensions: readonly ExtensionDefinition[],
	infrastructureJobs: readonly AnyJobDefinition[] = [],
): Registry {
	const ordered = orderExtensions(extensions);
	const actions = new Map<string, AnyActionDefinition>();
	const jobs = new Map<string, AnyJobDefinition>();
	const events = new Map<string, EventDefinition>();
	const operationIds = new Set<string>();
	const routes: Registry['routes'][number][] = [];

	/** The extension that declared each action, so a problem with one names its extension. */
	const actionOwner = new Map<string, string>();
	const unique = <T>(map: Map<string, T>, key: string, value: T, kind: string, owner?: string) => {
		if (map.has(key)) {
			if (owner === undefined) throw new Error(`Duplicate ${kind} "${key}"`);
			refuse(owner, `Duplicate ${kind} "${key}"`);
		}
		map.set(key, value);
	};

	for (const ext of ordered) {
		for (const action of ext.actions) {
			unique(actions, action.id, action, 'action', ext.id);
			actionOwner.set(action.id, ext.id);
		}
		for (const job of ext.jobs) unique(jobs, job.name, job, 'job', ext.id);
		for (const event of ext.events) unique(events, event.name, event, 'event', ext.id);
		for (const route of ext.routes) {
			if (operationIds.has(route.operationId))
				refuse(ext.id, `Duplicate operationId "${route.operationId}"`);
			operationIds.add(route.operationId);
			routes.push({ extension: ext.id, route });
		}
	}
	for (const job of infrastructureJobs) unique(jobs, job.name, job, 'job');
	const coreFirst = [...ordered].sort((a, b) => Number(b.id === 'core') - Number(a.id === 'core'));
	const capabilities = new Map<string, CapabilityDefinition>();
	for (const ext of coreFirst) {
		for (const capability of ext.capabilities) {
			try {
				assertRestrictiveDefaults(ext.id, capability);
			} catch (error) {
				refuse(ext.id, error instanceof Error ? error.message : String(error));
			}
			unique(capabilities, capability.id, capability, 'capability', ext.id);
		}
	}
	const notificationKinds = new Map<string, NotificationKindDefinition>();
	const kindOwner = new Map<string, string>();
	for (const ext of coreFirst) {
		for (const kind of ext.notifications) {
			if (!kind.id.startsWith(`${ext.id}.`))
				refuse(ext.id, `Notification kind "${kind.id}" must be namespaced as "${ext.id}.…"`);
			unique(notificationKinds, kind.id, kind, 'notification kind', ext.id);
			kindOwner.set(kind.id, ext.id);
		}
	}
	const digests = new Map<string, string>();
	/**
	 * A digest is the one read of its topic, kept by the area the topic belongs to, with the
	 * digest's own input and output, so code can ask it without knowing the extension.
	 */
	const checkDigest = (action: AnyActionDefinition, topic: string, owner: string) => {
		const where = `Digest "${action.id}"`;
		if (!Object.hasOwn(QUESTION_TOPICS, topic))
			refuse(owner, `${where} names unknown topic "${topic}"`);
		const area = QUESTION_TOPICS[topic as QuestionTopic];
		if (area !== owner) refuse(owner, `${where} is for "${topic}", which the "${area}" area keeps`);
		if (!action.readOnly) refuse(owner, `${where} must be read-only`);
		if (action.input !== DigestInputSchema || action.output !== DigestOutputSchema)
			refuse(owner, `${where} must take and give the digest's own shapes (use defineDigest)`);
		const first = digests.get(topic);
		if (first !== undefined)
			refuse(owner, `Topic "${topic}" has two digests: "${first}" and "${action.id}"`);
		digests.set(topic, action.id);
	};
	const known = (id: string | undefined, where: string, owner: string) => {
		if (id !== undefined && !capabilities.has(id))
			refuse(owner, `${where} names unknown capability "${id}"`);
	};
	for (const kind of notificationKinds.values())
		known(kind.audience, `Notification kind "${kind.id}"`, kindOwner.get(kind.id) as string);
	for (const action of actions.values()) {
		const owner = actionOwner.get(action.id) as string;
		known(action.requires, `Action "${action.id}"`, owner);
		const unless = typeof action.approval === 'object' ? action.approval.unless : undefined;
		known(unless, `Action "${action.id}"`, owner);
		if (!action.readOnly && !action.requires && !unless) {
			refuse(
				owner,
				`Action "${action.id}" changes data but declares neither \`requires\` nor \`approval: { unless }\``,
			);
		}
		// AI changes must always be drafts: an AI-proposable action cannot skip approval.
		// A read-only action with AI hints is a read tool and changes nothing.
		if (action.ai && !action.readOnly && action.approval === 'never') {
			refuse(owner, `Action "${action.id}" has AI hints but would apply AI changes directly`);
		}
		// The AI has no way out: an action that sends data outside is never AI-proposable.
		if (action.ai && action.external) {
			refuse(owner, `Action "${action.id}" is external and cannot have AI hints`);
		}
		const topic = action.ai?.digest;
		if (topic !== undefined) checkDigest(action, topic, owner);
	}
	// Auto-approval only for ordinary, internal, non-sensitive data changes.
	for (const ext of ordered) {
		for (const action of ext.actions) {
			if (!action.autoApprove) continue;
			const where = `Action "${action.id}"`;
			if (action.readOnly || action.external || ext.id === 'core' || ext.sensitive)
				refuse(ext.id, `${where} cannot be auto-approved`);
			for (const id of action.autoApprove.capabilities) known(id, where, ext.id);
		}
	}
	for (const ext of ordered) {
		for (const id of [ext.ai?.context ?? []].flat()) {
			const action = actions.get(id);
			if (!action || !ext.actions.includes(action))
				refuse(ext.id, `Extension "${ext.id}" names AI context action "${id}", which it lacks`);
			if (!action.readOnly) refuse(ext.id, `AI context action "${id}" must be read-only`);
		}
	}
	for (const ext of ordered) checkMentionKinds(ext, actions);
	for (const ext of ordered) {
		for (const [kind, def] of Object.entries(ext.ai?.index?.kinds ?? {})) {
			known(def.capability, `Search kind "${kind}"`, ext.id);
			known(def.viewAll, `Search kind "${kind}"`, ext.id);
		}
	}
	for (const { extension, route } of routes) {
		if (!ROUTE_ACCESS.has(route.requires))
			known(route.requires, `Route "${route.operationId}"`, extension);
	}
	checkManifests(ordered, actions);
	const sole = <T>(contract: string, pick: (ext: ExtensionDefinition) => T | undefined) => {
		const providers = ordered.flatMap((ext) => {
			const value = pick(ext);
			return value === undefined ? [] : [{ extension: ext.id, value }];
		});
		const second = providers[1];
		if (second)
			refuse(
				second.extension,
				`Only one extension may provide ${contract}: ${providers.map((p) => `"${p.extension}"`).join(', ')}`,
			);
		return providers[0] ?? null;
	};
	const share = sole('shareTarget', (ext) => ext.shareTarget);
	const conversation = sole('conversation', (ext) => ext.conversation);
	if (share) known(share.value.requires, `Share target of "${share.extension}"`, share.extension);
	if (conversation)
		known(
			conversation.value.requires,
			`Conversation of "${conversation.extension}"`,
			conversation.extension,
		);
	return {
		extensions: ordered,
		actions,
		jobs,
		events,
		routes,
		capabilities: [...capabilities.values()],
		notificationKinds,
		shareTarget: share && { extension: share.extension, target: share.value },
		conversation: conversation && {
			extension: conversation.extension,
			provider: conversation.value,
		},
	};
}
