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
	ShareTarget,
} from '@famos/sdk';
import { assertRestrictiveDefaults, SDK_VERSION, satisfiesCaret, tablePrefixOf } from '@famos/sdk';

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

/** Orders extensions so that every extension comes after its dependencies. */
export function orderExtensions(extensions: readonly ExtensionDefinition[]): ExtensionDefinition[] {
	const byId = new Map<string, ExtensionDefinition>();
	for (const ext of extensions) {
		if (byId.has(ext.id)) throw new Error(`Duplicate extension id "${ext.id}"`);
		byId.set(ext.id, ext);
	}
	const ordered: ExtensionDefinition[] = [];
	const state = new Map<string, 'visiting' | 'done'>();
	const visit = (ext: ExtensionDefinition, path: string[]) => {
		const s = state.get(ext.id);
		if (s === 'done') return;
		if (s === 'visiting')
			throw new Error(`Extension dependency cycle: ${[...path, ext.id].join(' → ')}`);
		state.set(ext.id, 'visiting');
		for (const dep of ext.manifest.dependsOn) {
			const target = byId.get(dep);
			if (!target) throw new Error(`Extension "${ext.id}" depends on missing extension "${dep}"`);
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
		if (manifest.id !== ext.id)
			throw new Error(`${where} carries the manifest of "${manifest.id}"`);
		if (!satisfiesCaret(SDK_VERSION, manifest.sdk))
			throw new Error(`${where} needs SDK ${manifest.sdk}, but this host has ${SDK_VERSION}`);

		for (const dep of manifest.dependsOn) {
			if (manifest.optional.includes(dep))
				throw new Error(`${where} names "${dep}" both as a dependency and as optional`);
		}

		const declared = new Set(manifest.capabilities);
		const inCode = new Set(ext.capabilities.map((c) => c.id));
		const unlisted = [...inCode].filter((id) => !declared.has(id));
		const absent = [...declared].filter((id) => !inCode.has(id));
		if (unlisted.length)
			throw new Error(`${where} declares capabilities its manifest lacks: ${unlisted.join(', ')}`);
		if (absent.length)
			throw new Error(`${where} lists capabilities its code lacks: ${absent.join(', ')}`);

		const implemented: Record<HostContract, boolean> = {
			shareTarget: ext.shareTarget !== undefined,
			conversation: ext.conversation !== undefined,
		};
		for (const [contract, inCode] of Object.entries(implemented)) {
			const listed = manifest.provides.includes(contract as HostContract);
			if (inCode && !listed)
				throw new Error(`${where} implements ${contract}, which its manifest's provides lacks`);
			if (listed && !inCode)
				throw new Error(`${where} lists ${contract} in provides, but its code lacks it`);
		}

		const prefix = tablePrefixOf(manifest);
		for (const other of prefixes) {
			if (prefix.startsWith(other.prefix) || other.prefix.startsWith(prefix))
				throw new Error(
					`${where} and "${other.id}" have overlapping table prefixes "${prefix}" and "${other.prefix}"`,
				);
		}
		prefixes.push({ id: ext.id, prefix });

		for (const call of manifest.calls) {
			const owner = call.slice(0, call.indexOf('.'));
			if (owner === ext.id)
				throw new Error(`${where} lists its own action "${call}" in calls; list only foreign ones`);
			const reachable =
				owner === 'core' || manifest.dependsOn.includes(owner) || manifest.optional.includes(owner);
			if (!reachable)
				throw new Error(
					`${where} calls "${call}", but "${owner}" is neither a dependency nor optional`,
				);
			// An optional extension that is not installed has no actions to check.
			if (present.has(owner) && !actions.has(call))
				throw new Error(`${where} calls "${call}", which "${owner}" does not have`);
		}
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

	const unique = <T>(map: Map<string, T>, key: string, value: T, kind: string) => {
		if (map.has(key)) throw new Error(`Duplicate ${kind} "${key}"`);
		map.set(key, value);
	};

	for (const ext of ordered) {
		for (const action of ext.actions) unique(actions, action.id, action, 'action');
		for (const job of ext.jobs) unique(jobs, job.name, job, 'job');
		for (const event of ext.events) {
			unique(events, event.name, event, 'event');
		}
		for (const route of ext.routes) {
			if (operationIds.has(route.operationId))
				throw new Error(`Duplicate operationId "${route.operationId}"`);
			operationIds.add(route.operationId);
			routes.push({ extension: ext.id, route });
		}
	}
	for (const job of infrastructureJobs) unique(jobs, job.name, job, 'job');
	const capabilities = new Map<string, CapabilityDefinition>();
	for (const ext of [...ordered].sort(
		(a, b) => Number(b.id === 'core') - Number(a.id === 'core'),
	)) {
		for (const capability of ext.capabilities) {
			assertRestrictiveDefaults(ext.id, capability);
			unique(capabilities, capability.id, capability, 'capability');
		}
	}
	const notificationKinds = new Map<string, NotificationKindDefinition>();
	for (const ext of [...ordered].sort(
		(a, b) => Number(b.id === 'core') - Number(a.id === 'core'),
	)) {
		for (const kind of ext.notifications) {
			if (!kind.id.startsWith(`${ext.id}.`))
				throw new Error(`Notification kind "${kind.id}" must be namespaced as "${ext.id}.…"`);
			unique(notificationKinds, kind.id, kind, 'notification kind');
		}
	}
	const known = (id: string | undefined, where: string) => {
		if (id !== undefined && !capabilities.has(id))
			throw new Error(`${where} names unknown capability "${id}"`);
	};
	for (const kind of notificationKinds.values())
		known(kind.audience, `Notification kind "${kind.id}"`);
	for (const action of actions.values()) {
		known(action.requires, `Action "${action.id}"`);
		const unless = typeof action.approval === 'object' ? action.approval.unless : undefined;
		known(unless, `Action "${action.id}"`);
		if (!action.readOnly && !action.requires && !unless) {
			throw new Error(
				`Action "${action.id}" changes data but declares neither \`requires\` nor \`approval: { unless }\``,
			);
		}
		// AI changes must always be drafts: an AI-proposable action cannot skip approval.
		// A read-only action with AI hints is a read tool and changes nothing.
		if (action.ai && !action.readOnly && action.approval === 'never') {
			throw new Error(`Action "${action.id}" has AI hints but would apply AI changes directly`);
		}
		// The AI has no way out: an action that sends data outside is never AI-proposable.
		if (action.ai && action.external) {
			throw new Error(`Action "${action.id}" is external and cannot have AI hints`);
		}
	}
	// Auto-approval only for ordinary, internal, non-sensitive data changes.
	for (const ext of ordered) {
		for (const action of ext.actions) {
			if (!action.autoApprove) continue;
			const where = `Action "${action.id}"`;
			if (action.readOnly || action.external || ext.id === 'core' || ext.sensitive)
				throw new Error(`${where} cannot be auto-approved`);
			for (const id of action.autoApprove.capabilities) known(id, where);
		}
	}
	for (const ext of ordered) {
		for (const id of [ext.ai?.context ?? []].flat()) {
			const action = actions.get(id);
			if (!action || !ext.actions.includes(action))
				throw new Error(`Extension "${ext.id}" names AI context action "${id}", which it lacks`);
			if (!action.readOnly) throw new Error(`AI context action "${id}" must be read-only`);
		}
	}
	for (const ext of ordered) {
		for (const [kind, def] of Object.entries(ext.ai?.index?.kinds ?? {})) {
			known(def.capability, `Search kind "${kind}"`);
			known(def.viewAll, `Search kind "${kind}"`);
		}
	}
	for (const { route } of routes) {
		if (!ROUTE_ACCESS.has(route.requires)) known(route.requires, `Route "${route.operationId}"`);
	}
	checkManifests(ordered, actions);
	const sole = <T>(contract: string, pick: (ext: ExtensionDefinition) => T | undefined) => {
		const providers = ordered.flatMap((ext) => {
			const value = pick(ext);
			return value === undefined ? [] : [{ extension: ext.id, value }];
		});
		if (providers.length > 1)
			throw new Error(
				`Only one extension may provide ${contract}: ${providers.map((p) => `"${p.extension}"`).join(', ')}`,
			);
		return providers[0] ?? null;
	};
	const share = sole('shareTarget', (ext) => ext.shareTarget);
	const conversation = sole('conversation', (ext) => ext.conversation);
	if (share) known(share.value.requires, `Share target of "${share.extension}"`);
	if (conversation)
		known(conversation.value.requires, `Conversation of "${conversation.extension}"`);
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
