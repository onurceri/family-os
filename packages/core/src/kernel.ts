import type {
	ActionInvoker,
	Actor,
	AiActionInfo,
	AnyActionDefinition,
	AnyJobDefinition,
	Clock,
	DbExecutor,
	EventBus,
	ExtensionContext,
	ExtensionDefinition,
	ExternalHttp,
	FileStore,
	IdentityAdmin,
	IdGenerator,
	JobContext,
	JobQueue,
	LlmPort,
	Logger,
	Migrations,
	NotificationChannel,
	NotifyRequest,
	SecretBox,
} from '@famos/sdk';
import { QUESTION_TOPIC_IDS, type QuestionTopic, tablePrefixOf } from '@famos/sdk';
import type { KyselyPlugin } from 'kysely';
import { z } from 'zod';
import { type Access, createAccess } from './access.ts';
import { type ActionRunner, createActionRunner, type ExtensionViews } from './action-runner.ts';
import { type AiAreas, createAiAreas } from './ai-areas.ts';
import { aiMissingAreas } from './ai-missing-areas.ts';
import { mayUseAsAi } from './ai-tools.ts';
import { type ApiTokenService, createApiTokenService, revokeTokensOf } from './api-tokens.ts';
import { type AppService, createAppService } from './apps.ts';
import { DEFAULT_DRAFT_NOTIFY_DELAY_MS } from './auto-approval.ts';
import { type ChangesReader, createChanges } from './changes.ts';
import { aiAreasChanged, featuresChanged, memberChanged, roleChanged } from './core-events.ts';
import { createCoreExtension, END_CREDENTIALS_JOB } from './core-extension.ts';
import { createDeviceService, type DeviceService } from './devices.ts';
import { createEventBus, type InProcessEventBus } from './event-bus.ts';
import { createExtensionInstall, type ExtensionList } from './extension-install.ts';
import {
	type ExtensionPackagesPort,
	noExtensionPackages,
	type RefusedExtension,
} from './extension-state.ts';
import { familyReader } from './family.ts';
import { createFeatures, type Features, ownerOf } from './features.ts';
import { createHostDoors, type HostDoors } from './host-doors.ts';
import { anyLanguage, type LanguagePort } from './languages.ts';
import { createMentionKinds } from './mention-kinds.ts';
import {
	type BoundChannel,
	createNotifications,
	defaultTranslate,
	noVocabulary,
	type Translate,
	type Vocabulary,
} from './notifications.ts';
import {
	buildRegistry,
	ExtensionRefusedError,
	isExtensionRefusedError,
	type Registry,
} from './registry.ts';
import { type RestoreReport, reconcileRestore } from './restore.ts';
import {
	createSchemaNames,
	hostFiles,
	readOnlyPlugin,
	scopedFiles,
	scopedHttp,
	scopePlugin,
} from './scope.ts';
import { createSearch, SEARCH_ACTION, SYNC_JOB } from './search.ts';
import { createThemes, defaultThemes, type ThemePort, type Themes } from './themes.ts';
import { createWorker, type Worker, type WorkerOptions } from './worker.ts';

export interface KernelOptions {
	db: DbExecutor;
	queue: JobQueue;
	clock: Clock;
	ids: IdGenerator;
	logger: Logger;
	files: FileStore;
	/** Each extension's box for credentials at rest, with its own key derived from `FAMOS_SECRET`. */
	secrets: (extensionId: string) => SecretBox;
	/** Guarded outbound HTTP for extensions' jobs (SSRF protection, size cap, timeout). */
	http: ExternalHttp;
	identity: IdentityAdmin;
	/** Model access for background jobs only. */
	llm: LlmPort;
	extensions: readonly ExtensionDefinition[];
	/** Migrations owned by infrastructure adapters (queue, identity), run after core. */
	infrastructureMigrations: readonly { scope: string; migrations: Migrations }[];
	/**
	 * Jobs owned by infrastructure adapters (backup uploads), registered next to the extensions'.
	 * Names are `<scope>.<step>` like any job; the scope is the adapter's migration scope.
	 */
	infrastructureJobs?: readonly AnyJobDefinition[];
	appVersion: string;
	/** The one-time code first-run setup requires (the server always sets one). */
	setupCode?: string;
	worker?: WorkerOptions;
	/**
	 * Ways to reach people outside the app that the host brings (Web Push, Telegram). The installed
	 * extensions' own channels follow them. None by default: the in-app list only.
	 */
	channels?: readonly NotificationChannel[];
	/** The family's public address (`FAMOS_BASE_URL`), when set: notifications carry absolute links. */
	publicUrl?: string;
	/** Renders a translation key in a locale (the server builds it from the shared catalogs). */
	translate?: Translate;
	/** The words a key lists in every installed language; none by default. */
	vocabulary?: Vocabulary;
	/** The language packs available. Without one, English is listed and any well-formed code may be chosen. */
	languages?: LanguagePort;
	/** The theme packs available. Without one, only the default theme is listed. */
	themes?: ThemePort;
	/** How long a suggestion waits before it notifies approvers (default 30 s; shortened in E2E). */
	draftNotifyDelayMs?: number;
	/** The packages extensions can be installed from. None by default: the installed set is fixed. */
	extensionPackages?: ExtensionPackagesPort;
	/**
	 * Extensions the kernel may leave out when the registry refuses them (those not always
	 * installed); it starts without them and their dependents. Any other refusal stops it.
	 */
	refusable?: readonly string[];
	/** Installed extensions the composition root already could not load, and why. */
	refused?: readonly RefusedExtension[];
}

export interface Kernel {
	readonly registry: Registry;
	/** The host's context: every table, file and action. Extensions get `contextFor` instead. */
	readonly ctx: ExtensionContext;
	/**
	 * An extension's own context (its tables, files, secrets, network and calls); the host's
	 * for core and for names that are no extension.
	 */
	contextFor(extensionId: string): ExtensionContext;
	readonly runner: ActionRunner;
	readonly bus: InProcessEventBus;
	readonly worker: Worker;
	readonly devices: DeviceService;
	/** Personal API tokens for MCP clients. */
	readonly apiTokens: ApiTokenService;
	/** Connected apps and their keys. */
	readonly apps: AppService;
	/** Capabilities and roles. */
	readonly access: Access;
	/** The change log: what changed since a cursor, and a validator for a collection. */
	readonly changes: ChangesReader;
	/** Extensions turned on or off (Settings → Features). */
	readonly features: Features;
	/** What the AI may use per area (Settings → AI). */
	readonly aiAreas: AiAreas;
	/** Notification channels now: the host's, then those of the running extensions. */
	readonly channels: () => readonly BoundChannel[];
	/** Renders a translation key in a language (English when the language lacks it). */
	readonly translate: Translate;
	/** The language packs available. */
	readonly languages: LanguagePort;
	/** Theme packs and who chose which theme. */
	readonly themes: Themes;
	/** The member as an actor, or null when they are archived or unknown. */
	readonly memberActor: HostDoors['memberActor'];
	/**
	 * Hands what a member sent from outside the app (Telegram, email) to the installed share
	 * target, as that member, with the same checks as an upload in the app.
	 */
	readonly share: HostDoors['share'];
	/** What one share may carry, so a channel can trim before it sends; null without a target. */
	readonly shareLimits: HostDoors['shareLimits'];
	/**
	 * The installed conversation, for channels outside the app: ask as a member, and read the
	 * answer once `conversationAnswered` names it.
	 */
	readonly conversation: HostDoors['conversation'];
	/** Installed extensions that are not running, and why (the composition root's and the registry's). */
	readonly refused: readonly RefusedExtension[];
	/** The installed, running and installable extensions (`core.listExtensions`). */
	listExtensions(): Promise<ExtensionList>;
	/** All migration scopes in execution order: core, infrastructure, extensions. */
	readonly migrationScopes: readonly { scope: string; migrations: Migrations }[];
	/** Family search follows the AI settings: run after a model, provider or area changes. */
	reconcileSearch(): Promise<void>;
	/**
	 * The step for the first start after a backup was restored (run after `start`, before the
	 * worker): everyone signs in again, and what was ended since the backup stays ended. `previous`
	 * is the database the restore set aside, null on a new server; `hostSteps` carry the same for
	 * what the host's adapters keep (Telegram links) and return how many they carried.
	 */
	reconcileRestore(
		previous: DbExecutor | null,
		hostSteps?: readonly (() => Promise<number>)[],
	): Promise<RestoreReport>;
	/** Calls every extension's `register`. Run after migrations. */
	start(): Promise<void>;
	stop(): Promise<void>;
}

export function createKernel(options: KernelOptions): Kernel {
	const bus = createEventBus(options.logger);
	const devices = createDeviceService({
		db: options.db,
		clock: options.clock,
		ids: options.ids,
		bus,
		identity: options.identity,
		access: () => access,
		features: () => features,
	});
	const apiTokens = createApiTokenService({
		db: options.db,
		clock: options.clock,
		ids: options.ids,
		access: () => access,
	});
	const apps = createAppService({
		db: options.db,
		clock: options.clock,
		ids: options.ids,
		access: () => access,
	});
	let runner: ActionRunner | undefined;
	const features = createFeatures();
	const aiAreas = createAiAreas(
		(id) => registry.extensions.find((e) => e.id === id)?.sensitive === true,
	);
	const hostChannels: readonly BoundChannel[] = (options.channels ?? []).map((c) => ({
		id: c.id,
		label: c.label,
		onByDefault: true,
		isAvailableFor: (memberId) => c.isAvailableFor(memberId),
		send: (_ctx, memberId, message) => c.send(memberId, message),
	}));
	/** The host's channels, then each running extension's, bound to that extension. */
	const channelList = (): readonly BoundChannel[] => [
		...hostChannels,
		...registry.extensions
			.filter((ext) => features.isOn(ext.id))
			.flatMap((ext) =>
				// A package built with an earlier SDK has none.
				(ext.channels ?? []).map(
					(channel): BoundChannel => ({
						id: channel.id,
						label: channel.label,
						...(channel.hint && { hint: channel.hint }),
						onByDefault: channel.byDefault !== 'off',
						isAvailableFor: (memberId) => channel.isAvailableFor(contextFor(ext.id), memberId),
						send: (_ctx, memberId, message) =>
							channel.send(jobContextFor(ext.id), memberId, message),
					}),
				),
			),
	];
	const notifications = createNotifications({
		db: options.db,
		queue: options.queue,
		clock: options.clock,
		ids: options.ids,
		logger: options.logger,
		channels: channelList,
		...(options.publicUrl && { publicUrl: options.publicUrl }),
		translate: options.translate ?? defaultTranslate,
		registry: () => registry,
		access: () => access,
		features: () => features,
		wake: () => worker?.wake(),
	});
	const search = createSearch({
		db: options.db,
		clock: options.clock,
		ids: options.ids,
		logger: options.logger,
		llm: options.llm,
		registry: () => registry,
		access: () => access,
		aiAreas: () => aiAreas,
		features: () => features,
		invoke: (id, input, actor) => (runner as ActionRunner).invoke(id, input, actor),
		contextFor: (id) => contextFor(id),
	});
	const themes = createThemes({ themes: () => options.themes ?? defaultThemes });
	const refused: RefusedExtension[] = [...(options.refused ?? [])];
	const extensionInstall = createExtensionInstall({
		packages: () => options.extensionPackages ?? noExtensionPackages,
		registry: () => registry,
		refused: () => refused,
		features: () => features,
	});
	const enqueueIn = async (db: DbExecutor, job: string, payload: unknown) => {
		const def = registry.jobs.get(job);
		if (!def) throw new Error(`Unknown job "${job}"`);
		const id = await options.queue.enqueue(db, job, def.payload.parse(payload), {
			maxAttempts: def.maxAttempts,
		});
		worker?.wake();
		return id;
	};
	const core = createCoreExtension({
		themes,
		search,
		identity: options.identity,
		appVersion: options.appVersion,
		...(options.setupCode !== undefined && { setupCode: options.setupCode }),
		draftNotifyDelayMs: options.draftNotifyDelayMs ?? DEFAULT_DRAFT_NOTIFY_DELAY_MS,
		languages: () => options.languages ?? anyLanguage,
		devices: () => devices,
		access: () => access,
		features: () => features,
		extensionIds: () => registry.extensions.map((e) => e.id),
		extensions: () =>
			registry.extensions.map((e) => ({
				id: e.id,
				sensitive: e.sensitive,
				usesAi: e.actions.some((a) => a.ai !== undefined),
			})),
		aiAreas: () => aiAreas,
		registry: () => registry,
		notifications,
		extensionInstall,
		extensionDb: (id, db) => views.db(id, db),
		jobContext: (id) => jobContextFor(id),
		enqueueIn,
		runner: () => {
			if (!runner) throw new Error('Kernel not initialised');
			return runner;
		},
	});
	const registry = buildLeavingOutRefused(core, options, refused);
	const access = createAccess(
		registry.capabilities,
		(id) => features.isOn(id),
		(id) => aiAreas.access(id),
	);
	// Custom roles are cached; reload them whenever one changes (after its transaction commits).
	bus.on(roleChanged, () => access.refresh(options.db));
	bus.on(featuresChanged, async () => {
		await features.refresh(options.db);
		access.invalidate();
		worker?.wake();
		await reconcileSearch();
	});
	bus.on(aiAreasChanged, async () => {
		await aiAreas.refresh(options.db);
		await reconcileSearch();
	});
	// Archiving a member removes their sign-in. Requests are refused anyway (the actor must be active),
	// this also removes the stored sessions and credentials. Runs after the commit: identity shares the connection.
	bus.on(memberChanged, async ({ memberId, endSessions }) => {
		if (endSessions) {
			// Removes the sign-in too (password, PIN, sessions): the email can be used again.
			await options.identity.revokeAll(memberId);
		}
	});

	const byId = new Map(registry.extensions.map((e) => [e.id, e]));
	/** Core and the infrastructure adapters are the host: they see everything. */
	const isHost = (id: string) => id === 'core' || !byId.has(id);
	const schemaNames = createSchemaNames();
	const plugins = new Map<string, KyselyPlugin>();
	const pluginFor = (id: string) => {
		let plugin = plugins.get(id);
		if (!plugin) {
			const ext = byId.get(id) as ExtensionDefinition;
			plugin = scopePlugin(id, tablePrefixOf(ext.manifest), schemaNames);
			plugins.set(id, plugin);
		}
		return plugin;
	};
	const boxes = new Map<string, SecretBox>();
	const views: ExtensionViews = {
		db: (id, db) => (isHost(id) ? db : db.withPlugin(pluginFor(id))),
		files: (id, db) =>
			isHost(id)
				? hostFiles(options.files, db, options.clock.now)
				: scopedFiles(options.files, id, db, options.clock.now),
		secrets(id) {
			let box = boxes.get(id);
			if (!box) {
				box = options.secrets(id);
				boxes.set(id, box);
			}
			return box;
		},
	};

	let worker: Worker | undefined;
	/** Whether an embedding model is set: without one, search is not offered to the AI. */
	let embedReady = false;
	const refreshEmbedReady = async () => {
		try {
			const policy = await options.llm.policy('search', 'embed');
			embedReady = policy.enabled && policy.model !== null;
		} catch {
			embedReady = false;
		}
	};
	/**
	 * Family search follows the settings: after a change of an area, a feature, a
	 * model or a provider, one job removes what must go and rebuilds what must come.
	 */
	const reconcileSearch = async () => {
		await refreshEmbedReady();
		if (!search.hasIndex()) return;
		await ctx.enqueue(SYNC_JOB, {}, { dedupeKey: SYNC_JOB });
	};
	runner = createActionRunner({
		indexer: (enqueue, trx) => search.indexerFor(enqueue, trx),
		db: options.db,
		queue: options.queue,
		clock: options.clock,
		ids: options.ids,
		logger: options.logger,
		views,
		bus,
		registry,
		access,
		features,
		aiAreaAccess: (id) => aiAreas.access(id),
		notifier: notifications.notifier,
		translate: options.translate ?? defaultTranslate,
		vocabulary: options.vocabulary ?? noVocabulary,
		onJobsEnqueued: () => worker?.wake(),
		...(options.draftNotifyDelayMs !== undefined && {
			draftNotifyDelayMs: options.draftNotifyDelayMs,
		}),
	});

	const aiInfo = (a: AnyActionDefinition) => ({
		id: a.id,
		title: a.title,
		...(a.draftTitle && { draftTitle: a.draftTitle }),
		description: a.ai?.description ?? '',
		...(a.ai?.guidance && { guidance: a.ai.guidance }),
		inputSchema: z.toJSONSchema(a.input, { io: 'input', unrepresentable: 'any' }) as Record<
			string,
			unknown
		>,
	});
	const aiActions = [...registry.actions.values()].filter((a) => a.ai);
	const aiDraftActions = aiActions.filter((a) => !a.readOnly).map((a) => [a, aiInfo(a)] as const);
	// A digest is asked by code for a question's facts; it is never a tool the model chooses.
	const aiReadActions = aiActions
		.filter((a) => a.readOnly && a.ai?.digest === undefined)
		.map((a) => [a, aiInfo(a)] as const);
	const digestActions = QUESTION_TOPIC_IDS.flatMap((topic) => {
		const def = aiActions.find((a) => a.ai?.digest === topic);
		return def ? [[def, aiInfo(def)] as const] : [];
	});
	const aiContexts = registry.extensions.flatMap((e) =>
		e.ai?.context ? [[e.id, [e.ai.context].flat()] as const] : [],
	);
	const offered = (
		list: readonly (readonly [AnyActionDefinition, AiActionInfo])[],
		catalogOptions: { local?: boolean; actor?: Actor } | undefined,
	) =>
		list
			.filter(([a]) => {
				const owner = ownerOf(a.id);
				// Meant for a person's own request in the app's conversation: not for an AI reading
				// shared content, and not for outside agents.
				const forMember = catalogOptions?.actor;
				if (
					a.ai?.conversationOnly &&
					!(
						forMember?.kind === 'ai' &&
						forMember.onBehalfOf !== undefined &&
						forMember.mode === 'conversation'
					)
				)
					return false;
				if (!features.isOn(owner)) return false;
				if (a.id === SEARCH_ACTION && !embedReady) return false;
				const area = aiAreas.access(owner);
				if (area === 'off' || (area === 'local' && catalogOptions?.local !== true)) return false;
				return !catalogOptions?.actor || mayUseAsAi(access, a, catalogOptions.actor);
			})
			.map(([, info]) => info);
	const readOnly = new Map<string, KyselyPlugin>();
	const mentionKinds = createMentionKinds({
		registry,
		isOn: (id) => features.isOn(id),
		areaAccess: (id) => aiAreas.access(id),
		aiCatalog: (catalogOptions) => offered(aiDraftActions, catalogOptions),
		// The extension's own tables, and only reads of them.
		readDb(id) {
			let plugin = readOnly.get(id);
			if (!plugin) {
				plugin = readOnlyPlugin(id);
				readOnly.set(id, plugin);
			}
			return views.db(id, options.db).withPlugin(plugin);
		},
		family: familyReader(options.db),
		translate: options.translate ?? defaultTranslate,
		vocabulary: options.vocabulary ?? noVocabulary,
		clock: options.clock,
		logger: options.logger,
	});
	/** The actions as `caller` reaches them (the host when it is undefined). */
	const invokerFor = (caller: string | undefined): ActionInvoker => ({
		invoke: (id, input, actor, invokeOptions) =>
			(runner as ActionRunner).invoke(id, input, actor, {
				...invokeOptions,
				...(caller !== undefined && { caller }),
			}),
		// Not offered to the AI: actions of turned-off extensions, of areas that are off for the AI,
		// and of local-only areas unless the model that will see the catalog is local.
		// For an AI acting for a member, also actions that member could not use.
		aiCatalog: (catalogOptions) => offered(aiDraftActions, catalogOptions),
		aiReadTools: (catalogOptions) => offered(aiReadActions, catalogOptions),
		aiContextActions: () =>
			new Map(aiContexts.filter(([extensionId]) => features.isOn(extensionId))),
		aiDigests: (digestOptions) => {
			const open = new Set(offered(digestActions, digestOptions).map((info) => info.id));
			return digestActions.flatMap(([def]) =>
				open.has(def.id)
					? [{ topic: def.ai?.digest as QuestionTopic, actionId: def.id, area: ownerOf(def.id) }]
					: [],
			);
		},
		aiMissingAreas: (areaOptions) =>
			aiMissingAreas(
				{
					loaded: registry.extensions.map((e) => e.id),
					packages: (options.extensionPackages ?? noExtensionPackages).list(),
					isOn: (id) => features.isOn(id),
					access: (id) => aiAreas.access(id),
					translate: options.translate ?? defaultTranslate,
				},
				areaOptions?.local === true,
			),
		checkInput(id, input) {
			const def = registry.actions.get(id);
			if (!def) return [];
			const parsed = def.input.safeParse(input);
			return parsed.success
				? []
				: parsed.error.issues.map(
						(i: { path: readonly PropertyKey[]; message: string }) =>
							`${i.path.map(String).join('.') || '(input)'}: ${i.message}`,
					);
		},
		async targetTitle(id, input) {
			const def = registry.actions.get(id);
			if (!def?.targetTitle) return null;
			const parsed = def.input.safeParse(input);
			if (!parsed.success) return null;
			return def.targetTitle(
				{
					db: views.db(ownerOf(id), options.db),
					family: familyReader(options.db),
					translate: options.translate ?? defaultTranslate,
					now: options.clock.now(),
				},
				parsed.data,
			);
		},
		aiKinds: (kindOptions) => mentionKinds.aiKinds(kindOptions),
		resolveMentions: (kindId, mentions, env, actor) =>
			mentionKinds.resolveMentions(kindId, mentions, env, actor),
	});
	const ctx: ExtensionContext = {
		db: options.db,
		clock: options.clock,
		ids: options.ids,
		logger: options.logger,
		files: hostFiles(options.files, options.db, options.clock.now),
		secrets: views.secrets('core'),
		http: options.http,
		events: bus,
		actions: invokerFor(undefined),
		family: familyReader(options.db),
		translate: options.translate ?? defaultTranslate,
		vocabulary: options.vocabulary ?? noVocabulary,
		access,
		ai: search.indexerFor(
			(job, payload, enqueueOptions) => ctx.enqueue(job, payload, enqueueOptions),
			null,
		),
		async notify(request: NotifyRequest) {
			await notifications.notifier.enqueue(options.db, request);
			worker?.wake();
		},
		async enqueue(job, payload, enqueueOptions) {
			const def = registry.jobs.get(job);
			if (!def) throw new Error(`Unknown job "${job}"`);
			const id = await options.queue.enqueue(options.db, job, def.payload.parse(payload), {
				maxAttempts: def.maxAttempts,
				...enqueueOptions,
			});
			worker?.wake();
			return id;
		},
	};
	const contexts = new Map<string, ExtensionContext>();
	/**
	 * An extension's own view of the host: its tables, its files and those granted to it, its own
	 * secret key, the network its manifest declares, and the actions it may call.
	 */
	function contextFor(id: string): ExtensionContext {
		if (isHost(id)) return ctx;
		let made = contexts.get(id);
		if (!made) {
			const ext = byId.get(id) as ExtensionDefinition;
			made = {
				...ctx,
				db: views.db(id, options.db),
				files: views.files(id, options.db),
				secrets: views.secrets(id),
				http: scopedHttp(options.http, ext.manifest),
				actions: invokerFor(id),
			};
			contexts.set(id, made);
		}
		return made;
	}
	const jobContexts = new Map<string, JobContext>();
	const jobContextFor = (id: string): JobContext => {
		const key = isHost(id) ? 'core' : id;
		let made = jobContexts.get(key);
		if (!made) {
			made = {
				...contextFor(key),
				llm: options.llm,
				unit: (work) => (runner as ActionRunner).unit(key, work),
			};
			jobContexts.set(key, made);
		}
		return made;
	};
	worker = createWorker({
		queue: options.queue,
		registry,
		ctxFor: (job) => jobContextFor(ownerOf(job)),
		clock: options.clock,
		logger: options.logger,
		isOn: (id) => features.isOn(id),
		...(options.worker && { options: options.worker }),
	});

	const doors = createHostDoors({ db: options.db, registry, access, features, contextFor });

	/** An extension's migrations, kept to its own tables like the rest of its code. */
	const scopedMigrations = (ext: ExtensionDefinition): Migrations =>
		Object.fromEntries(
			Object.entries(ext.migrations).map(([name, migration]) => [
				name,
				{
					async up(db: DbExecutor) {
						// Raw SQL is checked against the schema as the extensions before it left it.
						await schemaNames.refresh(db);
						await migration.up(views.db(ext.id, db));
					},
				},
			]),
		);
	const coreFirst = registry.extensions.filter((e) => e.id === 'core');
	const rest = registry.extensions.filter((e) => e.id !== 'core');
	const migrationScopes = [
		...coreFirst.map((e) => ({ scope: e.id, migrations: e.migrations })),
		...options.infrastructureMigrations,
		...rest.map((e) => ({ scope: e.id, migrations: scopedMigrations(e) })),
	];

	return {
		registry,
		ctx,
		contextFor,
		runner,
		bus,
		worker,
		devices,
		apiTokens,
		apps,
		access,
		changes: createChanges({ db: options.db, clock: options.clock, access: () => access }),
		features,
		aiAreas,
		channels: channelList,
		translate: options.translate ?? defaultTranslate,
		languages: options.languages ?? anyLanguage,
		themes,
		memberActor: doors.memberActor,
		share: doors.share,
		shareLimits: doors.shareLimits,
		conversation: doors.conversation,
		refused,
		listExtensions: () => extensionInstall.describe(options.db),
		migrationScopes,
		reconcileSearch,
		reconcileRestore: (previous, hostSteps) =>
			reconcileRestore(
				{
					db: options.db,
					clock: options.clock,
					logger: options.logger,
					identity: options.identity,
					extensions: () => registry.extensions,
					jobContextFor,
					previousViewFor: (id, db) =>
						isHost(id) ? db : views.db(id, db).withPlugin(readOnlyPlugin(id)),
					endCredentialsOf: (memberId) =>
						options.db.transaction().execute(async (trx) => {
							await revokeTokensOf(trx, memberId, options.clock.now());
							await enqueueIn(trx, END_CREDENTIALS_JOB, { memberId });
						}),
					notify: (request) => ctx.notify(request),
				},
				previous,
				hostSteps,
			),
		async start() {
			await schemaNames.refresh(options.db);
			await access.refresh(options.db);
			await features.refresh(options.db);
			await aiAreas.refresh(options.db);
			// Event handlers of a turned-off extension do not run.
			for (const ext of registry.extensions) {
				try {
					await ext.register?.({
						...contextFor(ext.id),
						events: gatedEvents(bus, () => features.isOn(ext.id)),
					});
				} catch (error) {
					// The composition root records an optional package that cannot start, and starts
					// again without it.
					if (!options.refusable?.includes(ext.id)) throw error;
					const message = error instanceof Error ? error.message : String(error);
					throw new ExtensionRefusedError(ext.id, `Its start failed: ${message}`, 'start_failed');
				}
			}
			await reconcileSearch();
		},
		async stop() {
			await worker?.stop();
		},
	};
}

/**
 * Builds the registry; an extension it refuses is left out with its dependents when it may be
 * (it is not always installed), and the registry is built again without them. Each refusal is
 * added to `refused`.
 */
function buildLeavingOutRefused(
	core: ExtensionDefinition,
	options: KernelOptions,
	refused: RefusedExtension[],
): Registry {
	const refusable = new Set(options.refusable ?? []);
	let candidates = [...options.extensions];
	for (;;) {
		try {
			const registry = buildRegistry(
				[core, ...candidates],
				options.infrastructureJobs,
				(options.channels ?? []).map((c) => c.id),
			);
			assertNoInfrastructureClash(registry, options.infrastructureMigrations);
			return registry;
		} catch (error) {
			if (!isExtensionRefusedError(error) || !refusable.has(error.extensionId)) throw error;
			const out = new Set([error.extensionId]);
			// Whatever depends on a refused extension cannot run either.
			for (let grew = true; grew; ) {
				grew = false;
				for (const ext of candidates) {
					if (out.has(ext.id) || !ext.manifest.dependsOn.some((dep) => out.has(dep))) continue;
					if (!refusable.has(ext.id)) throw error;
					out.add(ext.id);
					grew = true;
				}
			}
			for (const ext of candidates) {
				if (!out.has(ext.id)) continue;
				refused.push(
					ext.id === error.extensionId
						? {
								id: ext.id,
								version: ext.manifest.version,
								reason: error.reason,
								code: error.code,
								...(error.params && { params: error.params }),
							}
						: {
								id: ext.id,
								version: ext.manifest.version,
								reason: `It needs "${error.extensionId}", which was refused`,
								code: 'dependency_refused',
								params: { extensionId: error.extensionId },
							},
				);
			}
			candidates = candidates.filter((ext) => !out.has(ext.id));
		}
	}
}

/**
 * The registry refuses the names the host reserves; an infrastructure scope added without a
 * reserved name is refused here too, by its scope name.
 */
function assertNoInfrastructureClash(
	registry: Registry,
	infrastructure: KernelOptions['infrastructureMigrations'],
) {
	for (const { scope } of infrastructure) {
		const clash = registry.extensions.find((e) => {
			const prefix = tablePrefixOf(e.manifest);
			return e.id === scope || prefix.startsWith(`${scope}_`) || `${scope}_`.startsWith(prefix);
		});
		if (clash)
			throw new ExtensionRefusedError(
				clash.id,
				`Extension "${clash.id}" clashes with the host's "${scope}" tables`,
				'name_clash',
			);
	}
}

/** The bus, with subscriptions that only fire while their extension is on. */
function gatedEvents(bus: InProcessEventBus, isOn: () => boolean): EventBus {
	return {
		...bus,
		on: (event, handler) =>
			bus.on(event, (payload) => {
				if (isOn()) return handler(payload);
			}),
	};
}
