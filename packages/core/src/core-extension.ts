import {
	type Actor,
	AI_AREA_ACCESS,
	type AiSettingsAdmin,
	type AnyActionDefinition,
	type BackupSettingsAdmin,
	BUILT_IN_ROLES,
	DAY_MS,
	type DbExecutor,
	DEFAULT_REMINDER_TIME,
	type DigestItem,
	type DraftAlternative,
	defineAction,
	defineDigest,
	defineExtension,
	defineJob,
	defineNotificationKind,
	defineRoute,
	digestOf,
	type EmailSettingsAdmin,
	type EventBus,
	type ExtensionContext,
	FamosError,
	type IdentityAdmin,
	idSchema,
	isFullSignIn,
	type JobContext,
	memberBehind,
	personPresent,
	SDK_VERSION,
	selfOf,
	subjectOf,
	systemActor,
	type TelegramLinkAdmin,
	type UnitOfWork,
} from '@famos/sdk';
import {
	dateLocale,
	daysAround,
	formatDate,
	formatLocaleForLanguage,
	resolveSpan,
	todayIn,
	weekOf,
	zoned,
} from '@famos/time';
import { z } from 'zod';
import type { Access } from './access.ts';
import { type ActionRunner, GONE, SETTLED } from './action-runner.ts';
import { createAdminActions } from './admin-actions.ts';
import { type AiAreas, readAiAreas, writeAiAreas } from './ai-areas.ts';
import { createAiSettingsActions } from './ai-settings-actions.ts';
import type { ApiTokenService } from './api-tokens.ts';
import { revokeTokensOf } from './api-tokens.ts';
import type { AppService } from './apps.ts';
import type { AuditTrail } from './audit.ts';
import { createAutoApproval } from './auto-approval.ts';
import { pruneChanges, schedulePruneChanges } from './changes.ts';
import { createChannelActions } from './channel-actions.ts';
import { CORE_CAPABILITIES } from './core-capabilities.ts';
import {
	aiAreasChanged,
	coreEvents,
	featuresChanged,
	memberChanged,
	roleChanged,
	sessionEnded,
} from './core-events.ts';
import { DecisionSchema } from './decide.ts';
import { DeviceSchema, type DeviceService, toDevice } from './devices.ts';
import { draftDateOf, EXPIRE_JOB, scheduleExpiry, WAITING_STATUSES } from './draft-expiry.ts';
import { waitingUnit } from './draft-notices.ts';
import type { createExtensionInstall } from './extension-install.ts';
import {
	FamilyNameSchema,
	FamilySettingsSchema,
	LanguageCodeSchema,
	readFamilySettings,
	regionFormats,
	writeFamilySettings,
} from './family.ts';
import { type Features, ownerOf, readDisabled, writeDisabled } from './features.ts';
import { pruneIdempotency, schedulePrune } from './idempotency.ts';
import { createLanguages, familySettingsChanged, type LanguagePort } from './languages.ts';
import { createMemory } from './memory.ts';
import { coreMigrations } from './migrations/0001_init.ts';
import { NextUpModeSchema, readNextUp, setMyNextUp } from './next-up.ts';
import type { createNotifications } from './notifications.ts';
import {
	type OAuthService,
	oauthCleanup,
	oauthNotifications,
	scheduleOAuthCleanup,
} from './oauth.ts';
import type { Registry } from './registry.ts';
import type { Search } from './search.ts';
import { readStoredInput } from './stored-input.ts';
import type { CoreTables, DraftRow, MemberRow } from './tables.ts';
import type { Themes } from './themes.ts';

/**
 * Member colors. Eight hues kept away from coral/red so a member's
 * color never reads as "attention". Assigned in order; admins can change them.
 */
export const MEMBER_COLORS = [
	'#3d7aae',
	'#c38f22',
	'#975cbd',
	'#2f9a94',
	'#c66591',
	'#68778b',
	'#996c46',
	'#5c923d',
];

const MemberIdSchema = idSchema('member');
const ColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);
const LocaleSchema = LanguageCodeSchema;
const RoleIdSchema = z.string().min(1).max(60);
const AboutSchema = z.string().trim().max(300);

export const MemberSchema = z.object({
	id: z.string(),
	displayName: z.string(),
	roleId: z.string(),
	/** Free text about the person, for context; no security meaning. */
	about: z.string().nullable(),
	color: z.string(),
	locale: LocaleSchema.nullable(),
	createdAt: z.number(),
	archived: z.boolean(),
});
export type Member = z.infer<typeof MemberSchema>;

/** Which logins a person has (never the email, password or PIN themselves). */
export const SignInMethodsSchema = z.object({
	/** An email and password: works on every device. */
	password: z.boolean(),
	/** A PIN: works only on family devices. */
	pin: z.boolean(),
});
const NO_SIGN_IN = { password: false, pin: false };

export const RoleViewSchema = z.object({
	id: z.string(),
	/** Null for built-in roles: the UI shows their translated name. */
	name: z.string().nullable(),
	builtIn: z.boolean(),
	base: z.enum(['admin', 'member', 'supervised', 'guest']),
	overrides: z.record(z.string(), z.boolean()),
	/** Effective capability ids. */
	capabilities: z.array(z.string()),
	/** Active members with this role. */
	members: z.number().int(),
});

export const CapabilityViewSchema = z.object({
	id: z.string(),
	/** i18n key, e.g. `calendar:cap_edit`. */
	label: z.string(),
	level: z.enum(['view', 'use', 'edit', 'manage']),
	critical: z.boolean(),
	/** The extension (or `core`) that declared it. */
	owner: z.string(),
});

const DRAFT_STATUSES = [
	'pending',
	'approved',
	'rejected',
	'applied',
	'failed',
	'undone',
	'expired',
] as const;

/** How many of the newest drafts `core.mySuggestions` looks through to find the member's own. */
const MY_SUGGESTIONS_WINDOW = 300;

/** How many waiting suggestions the suggestions digest names, newest first. */
const SUGGESTIONS_DIGEST_LIMIT = 15;

const SUGGESTION_STATUS = {
	pending: 'waiting',
	failed: 'failed',
	approved: 'approved',
	applied: 'approved',
	rejected: 'rejected',
	undone: 'undone',
	expired: 'expired',
} as const satisfies Record<(typeof DRAFT_STATUSES)[number], string>;

/** The action's title and, when the input has one, its name or text: "Add shopping item: Milk". */
function suggestionLabel(
	title: string | undefined,
	row: DraftRow,
	subject: string | undefined = subjectOf(row.edited_input ?? row.input),
	scope?: string,
): string {
	const what = subject;
	const base = title ?? row.action_id;
	const label = what ? `${base}: ${what}` : base;
	return scope ? `${label} (${scope})` : label;
}

export const DraftSchema = z.object({
	id: z.string(),
	actionId: z.string(),
	input: z.unknown(),
	editedInput: z.unknown().nullable(),
	/** `expired`: nobody decided it and the day it was about has passed (it never runs). */
	status: z.enum(DRAFT_STATUSES),
	proposedBy: z.unknown(),
	/**
	 * The app it came through, by its current name, or null: a connected app (`connected`), or an
	 * AI app working through an app key or a sign-in (`ai`, named for the sign-in's app or the key).
	 */
	app: z.object({ id: z.string(), name: z.string(), kind: z.enum(['connected', 'ai']) }).nullable(),
	sourceKind: z.string().nullable(),
	sourceId: z.string().nullable(),
	summary: z.string().nullable(),
	confidence: z.number().nullable(),
	uncertainFields: z.array(z.string()),
	/** The words of the shared message it rests on, as the message writes them; null when none. */
	quote: z.string().nullable(),
	/** `failed` when applying it did not work (the stored message can carry internals), else null. */
	error: z.literal('failed').nullable(),
	/** Addressed to this member alone (a memory, a question): only they decide it. */
	forMember: z.string().nullable(),
	createdAt: z.number(),
	decidedAt: z.number().nullable(),
	/** Approved by a person's auto-approval setting; `decidedBy` is who turned it on. */
	autoApproved: z.boolean(),
	decidedBy: z.string().nullable(),
	/** Applied and its action can take it back (Undo). */
	undoable: z.boolean(),
	/**
	 * Why a draft is closed when a person did not decide it on its merits: `gone` (what
	 * it was about no longer exists; a waiting one is shown as expired with it), `settled` (what it asked for was already so) or `withdrawn`
	 * (the person behind it took it back). Null otherwise.
	 */
	reason: z.enum(['gone', 'settled', 'withdrawn']).nullable(),
	/** i18n key naming what the draft proposes, for a draft no presenter or summary describes. */
	titleKey: z.string().nullable(),
	/**
	 * What it is about, by name ("Piano lesson"): the name stored with it, else what the thing it
	 * points at is called now. Null when nothing names it.
	 */
	subject: z.string().nullable(),
	/** Pending only: what it proposes seems to exist already ("this may already be there"). */
	mayExist: z.boolean(),
	/** Pending only: part of what it proposes seems to exist already. */
	mayExistSome: z.boolean(),
	/**
	 * Pending only: another action it could become, offered to the reviewer (a new event whose
	 * title names one already on the calendar becomes a change of that one). `at` is when the
	 * thing already there is. Choosing it is `core.replaceDraft`.
	 */
	instead: z
		.object({
			actionId: z.string(),
			input: z.unknown(),
			at: z.object({ date: z.string(), time: z.string().optional() }).optional(),
		})
		.nullable(),
	/**
	 * Waiting only: what the fields it changes hold now, keyed like its input, so the card reads
	 * "old → new". Null for actions that do not say, and when the thing is gone.
	 */
	before: z.record(z.string(), z.unknown()).nullable(),
	/** The action it proposed before a reviewer chose its alternative; null when it never changed. */
	replacedFrom: z.string().nullable(),
	/** Whether the member reading it may decide it (approve or reject it on its merits). */
	canDecide: z.boolean(),
	/** Undone only: it was suggested again (`core.suggestDraftAgain`), as another draft. */
	suggestedAgain: z.boolean(),
	/**
	 * Waiting only: nobody can decide it now because the extension its action belongs to is not
	 * installed or is turned off. `labels` are that extension's names by language when known (an
	 * extension that is not installed has no texts loaded). Null otherwise.
	 */
	unavailable: z
		.object({
			reason: z.enum(['not_installed', 'turned_off']),
			extension: z.string(),
			labels: z.record(z.string(), z.string()),
		})
		.nullable(),
});

const toMember = (row: MemberRow): Member => ({
	id: row.id,
	displayName: row.display_name,
	roleId: row.role_id,
	about: row.about,
	color: row.color,
	locale: row.locale,
	createdAt: row.created_at,
	archived: row.archived_at !== null,
});

/** Why a closed draft is closed, when no one decided it on its merits. */
function draftReason(row: DraftRow): 'gone' | 'settled' | 'withdrawn' | null {
	if (row.status !== 'rejected') return null;
	if (row.error === GONE) return 'gone';
	if (row.error === SETTLED) return 'settled';
	// Only a person taking back their own suggestion (or what their own share produced)
	// withdraws it; declining what an assistant or MCP client proposed is an ordinary rejection.
	const by = JSON.parse(row.proposed_by) as Actor;
	const proposer = selfOf(by);
	if (proposer !== null) return row.decided_by === proposer ? 'withdrawn' : null;
	// What a member shared is theirs to take back; what an AI they talk to proposed is not.
	return by.kind === 'ai' && by.mode === 'share' && row.decided_by === by.onBehalfOf
		? 'withdrawn'
		: null;
}

const toDraft = (
	row: DraftRow,
	undoable = false,
	mayExist: boolean | 'some' = false,
	titleKey: string | null = null,
	instead: DraftAlternative | null = null,
	canDecide = false,
	before: Record<string, unknown> | null = null,
	subject: string | null = null,
	suggestedAgain = false,
	read: (json: string) => unknown = JSON.parse,
	unavailable: z.infer<typeof DraftSchema>['unavailable'] = null,
	waitingGone = false,
	app: { id: string; name: string; kind: 'connected' | 'ai' } | null = null,
): z.infer<typeof DraftSchema> => ({
	id: row.id,
	actionId: row.action_id,
	input: read(row.input),
	editedInput: row.edited_input === null ? null : read(row.edited_input),
	status: row.status,
	proposedBy: JSON.parse(row.proposed_by),
	app,
	sourceKind: row.source_kind,
	sourceId: row.source_id,
	summary: row.summary,
	confidence: row.confidence,
	uncertainFields: row.uncertain_fields ? (JSON.parse(row.uncertain_fields) as string[]) : [],
	quote: row.quote,
	// The stored message can carry internals (SQL, paths); members see only that it failed.
	error: row.error === null || row.error === GONE || row.error === SETTLED ? null : 'failed',
	forMember: row.for_member,
	createdAt: row.created_at,
	decidedAt: row.decided_at,
	autoApproved: row.auto_approved === 1,
	decidedBy: row.decided_by,
	undoable,
	reason: waitingGone ? 'gone' : draftReason(row),
	titleKey,
	subject,
	mayExist: mayExist === true,
	mayExistSome: mayExist === 'some',
	instead: instead && {
		actionId: instead.actionId,
		input: instead.input,
		...(instead.at && { at: instead.at }),
	},
	before,
	replacedFrom:
		row.replaced === null ? null : (JSON.parse(row.replaced) as { actionId: string }).actionId,
	canDecide,
	suggestedAgain,
	unavailable,
});

const members = (db: DbExecutor) => db.withTables<CoreTables>();

async function findMember(db: DbExecutor, id: string): Promise<MemberRow> {
	const row = await members(db)
		.selectFrom('core_members')
		.selectAll()
		.where('id', '=', id)
		.executeTakeFirst();
	if (!row) throw new FamosError('not_found', 'Member not found');
	return row;
}

async function activeAdminCount(db: DbExecutor): Promise<number> {
	const row = await members(db)
		.selectFrom('core_members')
		.select((eb) => eb.fn.countAll<number>().as('n'))
		.where('role_id', '=', 'admin')
		.where('archived_at', 'is', null)
		.executeTakeFirstOrThrow();
	return Number(row.n);
}

async function insertMember(
	uow: Pick<UnitOfWork, 'db' | 'ids' | 'clock'>,
	input: {
		displayName: string;
		roleId: string;
		about?: string | undefined;
		color?: string | undefined;
		locale?: Member['locale'] | undefined;
	},
): Promise<MemberRow> {
	const count = await members(uow.db)
		.selectFrom('core_members')
		.select((eb) => eb.fn.countAll<number>().as('n'))
		.executeTakeFirstOrThrow();
	const now = uow.clock.now();
	const row: MemberRow = {
		id: uow.ids.next('member'),
		display_name: input.displayName,
		role_id: input.roleId,
		about: input.about?.trim() || null,
		color: input.color ?? MEMBER_COLORS[Number(count.n) % MEMBER_COLORS.length] ?? '#4b5563',
		locale: input.locale ?? null,
		created_at: now,
		updated_at: now,
		archived_at: null,
	};
	await members(uow.db).insertInto('core_members').values(row).execute();
	return row;
}

const requireMember = (actor: Actor) => {
	if (!personPresent(actor)) throw new FamosError('forbidden', 'Only members can do this');
	return actor;
};

/** Admins are told when an off-site backup could not be uploaded. */
export const backupFailed = defineNotificationKind({
	id: 'core.backupFailed',
	label: 'app:notify_kind_backup_failed',
	audience: 'core.settings.manage',
});

/** Admins are told what a restore kept from before it, and that everyone signs in again. */
export const backupRestored = defineNotificationKind({
	id: 'core.backupRestored',
	label: 'app:notify_kind_backup_restored',
	audience: 'core.settings.manage',
});

/** The person behind a suggestion is told when someone else approved or rejected it. */
export const draftDecided = defineNotificationKind({
	id: 'core.draftDecided',
	label: 'app:notify_kind_draft_decided',
	audience: 'core.drafts.propose',
});

/** Approvers are told when a suggestion waits for them (sent by the action runner). */
export const draftWaiting = defineNotificationKind({
	id: 'core.draftWaiting',
	label: 'app:notify_kind_draft_waiting',
	audience: 'core.drafts.approve',
});

/** Ends a member's keys and extension credentials; retried until it succeeds. */
export const END_CREDENTIALS_JOB = 'core.endCredentials';

export interface CoreExtensionDeps {
	/** Family search: its jobs, the `core.searchFamily` action and routes. */
	search: Pick<Search, 'jobs' | 'actions' | 'routes'>;
	identity: IdentityAdmin;
	aiSettings: AiSettingsAdmin;
	backupSettings: BackupSettingsAdmin;
	emailSettings: EmailSettingsAdmin;
	telegramLinks: TelegramLinkAdmin;
	runner: () => ActionRunner;
	devices: () => DeviceService;
	apps: () => AppService;
	apiTokens: () => ApiTokenService;
	oauth: () => OAuthService;
	/** Records what the credential routes did (they run outside actions). */
	audit: AuditTrail;
	appVersion: string;
	access: () => Access;
	features: () => Features;
	/** Ids of every registered extension (core first). */
	extensionIds: () => readonly string[];
	/** Every registered extension with whether it is marked sensitive (AI areas). */
	extensions: () => readonly {
		id: string;
		sensitive: boolean;
		usesAi: boolean;
	}[];
	aiAreas: () => AiAreas;
	/** The registry, for auto-approval (which actions opted in); available once the kernel has built it. */
	registry: () => Registry;
	/** Notification jobs, actions and routes. */
	notifications: ReturnType<typeof createNotifications>;
	/** Installing and uninstalling extensions, and restarting the server. */
	extensionInstall: Pick<
		ReturnType<typeof createExtensionInstall>,
		'actions' | 'routes' | 'events' | 'jobs' | 'namesOf'
	>;
	/** The one-time code first-run setup requires; there is no way to open setup without one. */
	setupCode: string;
	/** The language packs available; the composition root builds the registry. */
	languages: () => LanguagePort;
	/** Theme packs and who chose which theme; the kernel builds it from the composition root's registry. */
	themes: Themes;
	/** How long a suggestion waits before it notifies approvers. */
	draftNotifyDelayMs: number;
	/** `db` (a transaction too) as an extension sees it: its own tables. */
	extensionDb: (extensionId: string, db: DbExecutor) => DbExecutor;
	/** The context an extension's job runs with. */
	jobContext: (extensionId: string) => JobContext;
	/** Enqueues a job through the given executor, so it commits with the caller's transaction. */
	enqueueIn: (db: DbExecutor, job: string, payload: unknown) => Promise<string>;
}

/** Compares without an early exit, so timing does not reveal how much of a code matched. */
function sameCode(a: string, b: string): boolean {
	let diff = a.length ^ b.length;
	for (let i = 0; i < Math.max(a.length, b.length); i++)
		diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
	return diff === 0;
}

export function createCoreExtension(deps: CoreExtensionDeps) {
	const autoApproval = createAutoApproval({
		runner: deps.runner,
		access: deps.access,
		registry: deps.registry,
		draftNotifyDelayMs: deps.draftNotifyDelayMs,
	});
	/** A role id is a built-in role or an existing custom role. */
	const assertRole = (roleId: string) => {
		const access = deps.access();
		if (!access.isBuiltIn(roleId) && !access.customRoles().some((r) => r.id === roleId)) {
			throw new FamosError('bad_request', `Unknown role "${roleId}"`);
		}
	};

	/** Overrides may only name registered, non-critical capabilities. */
	const checkOverrides = (overrides: Record<string, boolean>) => {
		const access = deps.access();
		for (const id of Object.keys(overrides)) {
			const capability = access.capability(id);
			if (!capability) throw new FamosError('bad_request', `Unknown capability "${id}"`);
			if (capability.critical)
				throw new FamosError('bad_request', `"${id}" belongs to the Admin role only`);
		}
	};

	const languages = createLanguages({ languages: deps.languages });
	const memory = createMemory();
	const admin = createAdminActions({
		apps: deps.apps,
		apiTokens: deps.apiTokens,
		oauth: deps.oauth,
		devices: deps.devices,
		identity: deps.identity,
	});

	const createMember = defineAction({
		id: 'core.createMember',
		title: 'Add a family member',
		input: z.object({
			displayName: z.string().trim().min(1).max(60),
			roleId: RoleIdSchema,
			about: AboutSchema.optional(),
			color: ColorSchema.optional(),
			locale: LocaleSchema.optional(),
		}),
		output: MemberSchema,
		requires: CORE_CAPABILITIES.membersManage.id,
		approval: 'never',
		async run(uow, input) {
			assertRole(input.roleId);
			if (input.locale) languages.assertKnown(input.locale);
			const row = await insertMember(uow, input);
			uow.emit(memberChanged, { memberId: row.id });
			return toMember(row);
		},
	});

	const updateMember = defineAction({
		id: 'core.updateMember',
		title: 'Update a family member',
		input: z.object({
			memberId: MemberIdSchema,
			displayName: z.string().trim().min(1).max(60).optional(),
			roleId: RoleIdSchema.optional(),
			about: AboutSchema.nullable().optional(),
			color: ColorSchema.optional(),
			locale: LocaleSchema.nullable().optional(),
		}),
		output: MemberSchema,
		requires: CORE_CAPABILITIES.membersManage.id,
		approval: 'never',
		async run(uow, input) {
			if (input.roleId !== undefined) assertRole(input.roleId);
			if (input.locale) languages.assertKnown(input.locale);
			const current = await findMember(uow.db, input.memberId);
			if (
				current.role_id === 'admin' &&
				input.roleId !== undefined &&
				input.roleId !== 'admin' &&
				(await activeAdminCount(uow.db)) <= 1
			) {
				throw new FamosError('conflict', 'The last admin cannot be demoted', {
					reason: 'last_admin',
				});
			}
			await members(uow.db)
				.updateTable('core_members')
				.set({
					...(input.displayName !== undefined && { display_name: input.displayName }),
					...(input.roleId !== undefined && { role_id: input.roleId }),
					...(input.about !== undefined && { about: input.about?.trim() || null }),
					...(input.color !== undefined && { color: input.color }),
					...(input.locale !== undefined && { locale: input.locale }),
					updated_at: uow.clock.now(),
				})
				.where('id', '=', input.memberId)
				.execute();
			uow.emit(memberChanged, { memberId: input.memberId });
			return toMember(await findMember(uow.db, input.memberId));
		},
	});

	const setMyLanguage = defineAction({
		id: 'core.setMyLanguage',
		title: 'Choose my own language',
		input: z.object({ locale: LocaleSchema.nullable() }),
		output: MemberSchema,
		// Everyone may choose how the app speaks to them; it changes nothing for anyone else.
		requires: CORE_CAPABILITIES.notificationsReceive.id,
		approval: 'never',
		async run(uow, input) {
			const actor = requireMember(uow.actor);
			if (input.locale) languages.assertKnown(input.locale);
			await members(uow.db)
				.updateTable('core_members')
				.set({ locale: input.locale, updated_at: uow.clock.now() })
				.where('id', '=', actor.memberId)
				.execute();
			uow.emit(memberChanged, { memberId: actor.memberId });
			return toMember(await findMember(uow.db, actor.memberId));
		},
	});

	const archiveMember = defineAction({
		id: 'core.archiveMember',
		title: 'Remove a family member from the family',
		input: z.object({ memberId: MemberIdSchema }),
		output: MemberSchema,
		requires: CORE_CAPABILITIES.membersManage.id,
		approval: 'never',
		async run(uow, input) {
			const current = await findMember(uow.db, input.memberId);
			if (
				current.role_id === 'admin' &&
				current.archived_at === null &&
				(await activeAdminCount(uow.db)) <= 1
			) {
				throw new FamosError('conflict', 'The last admin cannot be archived', {
					reason: 'last_admin',
				});
			}
			const now = uow.clock.now();
			await members(uow.db)
				.updateTable('core_members')
				.set({ archived_at: now, updated_at: now })
				.where('id', '=', input.memberId)
				.execute();
			// Keys and addresses end in this transaction, or not at all.
			await revokeTokensOf(uow.db, input.memberId, now);
			await uow.enqueue(END_CREDENTIALS_JOB, { memberId: input.memberId });
			uow.emit(memberChanged, { memberId: input.memberId, endSessions: true });
			return toMember(await findMember(uow.db, input.memberId));
		},
	});

	const setFeatureEnabled = defineAction({
		id: 'core.setFeatureEnabled',
		title: 'Turn an extension on or off',
		input: z.object({ extensionId: z.string(), enabled: z.boolean() }),
		output: z.object({ extensionId: z.string(), enabled: z.boolean() }),
		requires: CORE_CAPABILITIES.featuresManage.id,
		approval: 'never',
		async run(uow, input) {
			if (!deps.extensionIds().includes(input.extensionId))
				throw new FamosError('bad_request', `Unknown extension "${input.extensionId}"`);
			if (input.extensionId === 'core')
				throw new FamosError('bad_request', 'Core cannot be turned off');
			const disabled = new Set(await readDisabled(uow.db));
			if (input.enabled) disabled.delete(input.extensionId);
			else disabled.add(input.extensionId);
			await writeDisabled(uow.db, [...disabled], uow.clock.now());
			// Data stays; the cache is refreshed after commit (kernel listener).
			uow.emit(featuresChanged, input);
			return input;
		},
	});

	const setAiAreaAccess = defineAction({
		id: 'core.setAiAreaAccess',
		title: 'Choose how far the AI may use an area',
		input: z.object({
			extensionId: z.string(),
			access: z.enum(AI_AREA_ACCESS),
			/** Required to open a sensitive area to any provider: the data leaves the house. */
			confirmSensitive: z.boolean().optional(),
		}),
		output: z.object({ extensionId: z.string(), access: z.enum(AI_AREA_ACCESS) }),
		requires: CORE_CAPABILITIES.aiManage.id,
		approval: 'never',
		async run(uow, input) {
			const area = deps.extensions().find((e) => e.id === input.extensionId);
			if (!area || input.extensionId === 'core')
				throw new FamosError('bad_request', `"${input.extensionId}" is not an area for the AI`);
			if (area.sensitive && input.access === 'any' && input.confirmSensitive !== true) {
				throw new FamosError(
					'bad_request',
					`"${input.extensionId}" is a sensitive area: opening it to any provider sends its data to that provider, so it needs confirmSensitive: true`,
				);
			}
			const areas = await readAiAreas(uow.db);
			areas[input.extensionId] = input.access;
			await writeAiAreas(uow.db, areas, uow.clock.now());
			// The cache is refreshed after commit (kernel listener).
			uow.emit(aiAreasChanged, { extensionId: input.extensionId, access: input.access });
			return { extensionId: input.extensionId, access: input.access };
		},
	});

	const updateFamilySettings = defineAction({
		id: 'core.updateFamilySettings',
		title: 'Change family settings (time zone, language, region formats)',
		input: FamilySettingsSchema.omit({ name: true }).partial(),
		output: FamilySettingsSchema,
		requires: CORE_CAPABILITIES.settingsManage.id,
		approval: 'never',
		async run(uow, input) {
			if (input.locale) languages.assertKnown(input.locale);
			const next = { ...(await readFamilySettings(uow.db)), ...input };
			await writeFamilySettings(uow.db, next, uow.clock.now());
			// Other open screens (language, region formats, time zone) refresh without a reload.
			uow.emit(familySettingsChanged, {});
			return next;
		},
	});

	const setFamilyName = defineAction({
		id: 'core.setFamilyName',
		title: 'Set or clear the family name',
		input: z.object({ name: z.string().trim().max(60) }),
		output: z.object({ name: z.string().nullable() }),
		requires: CORE_CAPABILITIES.settingsManage.id,
		approval: 'never',
		async run(uow, input) {
			const { name: _old, ...rest } = await readFamilySettings(uow.db);
			const name = input.name === '' ? null : input.name;
			await writeFamilySettings(
				uow.db,
				{ ...rest, ...(name !== null && { name }) },
				uow.clock.now(),
			);
			uow.emit(familySettingsChanged, {});
			return { name };
		},
	});

	const RoleInputSchema = z.object({
		name: z.string().trim().min(1).max(40),
		base: z.enum(['member', 'supervised', 'guest']),
		overrides: z.record(z.string(), z.boolean()).default({}),
	});

	const createRole = defineAction({
		id: 'core.createRole',
		title: 'Create a role from a built-in one',
		input: RoleInputSchema,
		output: z.object({ id: z.string() }),
		requires: CORE_CAPABILITIES.rolesManage.id,
		approval: 'never',
		async run(uow, input) {
			checkOverrides(input.overrides);
			const now = uow.clock.now();
			const id = uow.ids.next('role');
			await members(uow.db)
				.insertInto('core_roles')
				.values({
					id,
					name: input.name,
					base: input.base,
					overrides: JSON.stringify(input.overrides),
					created_at: now,
					updated_at: now,
				})
				.execute();
			uow.emit(roleChanged, { roleId: id });
			return { id };
		},
	});

	const updateRole = defineAction({
		id: 'core.updateRole',
		title: 'Rename a custom role or change its capabilities',
		input: z.object({
			id: idSchema('role'),
			name: RoleInputSchema.shape.name.optional(),
			overrides: z.record(z.string(), z.boolean()).optional(),
		}),
		output: z.object({ ok: z.literal(true) }),
		requires: CORE_CAPABILITIES.rolesManage.id,
		approval: 'never',
		async run(uow, input) {
			const row = await members(uow.db)
				.selectFrom('core_roles')
				.select('id')
				.where('id', '=', input.id)
				.executeTakeFirst();
			if (!row) throw new FamosError('not_found', 'Role not found');
			if (input.overrides) checkOverrides(input.overrides);
			await members(uow.db)
				.updateTable('core_roles')
				.set({
					...(input.name !== undefined && { name: input.name }),
					...(input.overrides !== undefined && { overrides: JSON.stringify(input.overrides) }),
					updated_at: uow.clock.now(),
				})
				.where('id', '=', input.id)
				.execute();
			uow.emit(roleChanged, { roleId: input.id });
			return { ok: true as const };
		},
	});

	const deleteRole = defineAction({
		id: 'core.deleteRole',
		title: 'Delete a custom role nobody has',
		input: z.object({ id: idSchema('role') }),
		output: z.object({ ok: z.literal(true) }),
		requires: CORE_CAPABILITIES.rolesManage.id,
		approval: 'never',
		async run(uow, { id }) {
			const used = await members(uow.db)
				.selectFrom('core_members')
				.select('id')
				.where('role_id', '=', id)
				.executeTakeFirst();
			if (used)
				throw new FamosError('conflict', 'Members still have this role (archived members too)');
			const app = await members(uow.db)
				.selectFrom('core_apps')
				.select('id')
				.where('role_id', '=', id)
				.where('revoked_at', 'is', null)
				.executeTakeFirst();
			if (app) throw new FamosError('conflict', 'A connected app still has this role');
			await members(uow.db).deleteFrom('core_roles').where('id', '=', id).execute();
			uow.emit(roleChanged, { roleId: id });
			return { ok: true as const };
		},
	});

	const listRoles = defineRoute({
		method: 'get',
		path: '/roles',
		operationId: 'core.listRoles',
		summary: 'Capabilities and roles, with what each role can do',
		requires: CORE_CAPABILITIES.membersView.id,
		response: z.object({
			capabilities: z.array(CapabilityViewSchema),
			roles: z.array(RoleViewSchema),
		}),
		async handle(ctx, { actor }) {
			// A display may see who lives here (with "show names"), not how roles are set up.
			if (actor.kind === 'display')
				throw new FamosError('forbidden', 'A display only shows', { reason: 'display' });
			const access = deps.access();
			const counts = await members(ctx.db)
				.selectFrom('core_members')
				.select(['role_id', (eb) => eb.fn.countAll<number>().as('n')])
				.where('archived_at', 'is', null)
				.groupBy('role_id')
				.execute();
			const count = (id: string) => Number(counts.find((c) => c.role_id === id)?.n ?? 0);
			const builtIn = BUILT_IN_ROLES.map((id) => ({
				id,
				name: null,
				builtIn: true,
				base: id,
				overrides: {},
				capabilities: [...access.effective(id)],
				members: count(id),
			}));
			const custom = access.customRoles().map((r) => ({
				id: r.id,
				name: r.name,
				builtIn: false,
				base: r.base,
				overrides: r.overrides,
				capabilities: [...access.effective(r.id)],
				members: count(r.id),
			}));
			return {
				capabilities: access.capabilities.map((c) => ({
					id: c.id,
					label: c.label,
					level: c.level,
					critical: c.critical === true,
					owner: c.id.split('.')[0] as string,
				})),
				roles: [...builtIn, ...custom],
			};
		},
	});

	const setupStatus = defineRoute({
		method: 'get',
		path: '/setup',
		operationId: 'core.getSetupStatus',
		summary: 'Whether first-run setup is still required',
		requires: 'public',
		response: z.object({
			needsSetup: z.boolean(),
			/** Setup asks for the one-time code printed in the server log. */
			needsCode: z.boolean(),
			appVersion: z.string(),
		}),
		async handle(ctx) {
			const any = await members(ctx.db)
				.selectFrom('core_members')
				.select('id')
				.limit(1)
				.executeTakeFirst();
			return {
				needsSetup: any === undefined,
				needsCode: true,
				appVersion: deps.appVersion,
			};
		},
	});

	const setup = defineRoute({
		method: 'post',
		path: '/setup',
		operationId: 'core.completeSetup',
		summary: 'Create the first admin (only while no members exist)',
		requires: 'public',
		status: 201,
		body: z.object({
			displayName: z.string().trim().min(1).max(60),
			email: z.email(),
			password: z.string().min(10).max(200),
			locale: LocaleSchema,
			timeZone: FamilySettingsSchema.shape.timeZone.optional(),
			/** Region formats, as the browser suggests them; anything left out is derived from the format locale. */
			...FamilySettingsSchema.pick({
				formatLocale: true,
				weekStart: true,
				hourCycle: true,
				temperatureUnit: true,
			}).partial().shape,
			familyName: FamilyNameSchema.optional(),
			/** The code from the server log or `data/setup-code`, so a fresh instance cannot be claimed. */
			setupCode: z.string().max(100).optional(),
		}),
		response: MemberSchema,
		async handle(ctx, { body }) {
			if (!sameCode(body.setupCode?.trim() ?? '', deps.setupCode))
				throw new FamosError('forbidden', 'The setup code is not correct');
			languages.assertKnown(body.locale);
			const row = await ctx.db.transaction().execute(async (trx) => {
				const any = await members(trx)
					.selectFrom('core_members')
					.select('id')
					.limit(1)
					.executeTakeFirst();
				if (any) throw new FamosError('conflict', 'Setup has already been completed');
				const settings = {
					...(body.familyName && { name: body.familyName }),
					timeZone: body.timeZone ?? 'UTC',
					locale: body.locale,
					...regionFormats(body.formatLocale ?? formatLocaleForLanguage(body.locale)),
					...(body.weekStart !== undefined && { weekStart: body.weekStart }),
					...(body.hourCycle && { hourCycle: body.hourCycle }),
					...(body.temperatureUnit && { temperatureUnit: body.temperatureUnit }),
					reminderTime: DEFAULT_REMINDER_TIME,
				};
				await writeFamilySettings(trx, settings, ctx.clock.now());
				return insertMember(
					{ db: trx, ids: ctx.ids, clock: ctx.clock },
					{ displayName: body.displayName, locale: body.locale, roleId: 'admin' },
				);
			});
			// Identity writes share the connection, so they run after the transaction (see IdentityAdmin).
			try {
				await deps.identity.setPasswordLogin({
					memberId: row.id,
					email: body.email,
					password: body.password,
					displayName: body.displayName,
				});
			} catch (error) {
				await members(ctx.db).deleteFrom('core_members').where('id', '=', row.id).execute();
				throw error;
			}
			// Nobody is signed in yet: the first admin and their password are made by setup itself.
			await deps.audit.record(systemActor('setup'), 'core.completeSetup', row.id);
			return toMember(row);
		},
	});

	const me = defineRoute({
		method: 'get',
		path: '/me',
		operationId: 'core.getMe',
		summary: 'The signed-in member, with what their role allows',
		requires: 'signedIn',
		response: MemberSchema.extend({
			/** What this sign-in allows: a PIN sign-in never holds critical capabilities. */
			capabilities: z.array(z.string()),
			/** How this person can sign in. */
			signIn: SignInMethodsSchema,
			/** Signed in with a password (not a PIN): only then may keys, tokens and addresses be made. */
			fullSignIn: z.boolean(),
			/** Extensions turned off in Settings → Features; their UI is hidden. */
			disabledExtensions: z.array(z.string()),
			/** Whose next thing the hero on Today shows (`core.setMyNextUp`). */
			nextUp: NextUpModeSchema,
		}),
		async handle(ctx, { actor }) {
			const row = await findMember(ctx.db, requireMember(actor).memberId);
			const access = deps.access();
			const signIn = (await deps.identity.signInMethods()).get(row.id) ?? NO_SIGN_IN;
			return {
				...toMember(row),
				capabilities: [...access.effective(row.role_id)].filter((c) => access.can(actor, c)),
				signIn,
				fullSignIn: isFullSignIn(actor),
				disabledExtensions: [...deps.features().disabled()],
				nextUp: await readNextUp(ctx.db, row.id),
			};
		},
	});

	/**
	 * For every data-changing action that is on, what running it would do for this sign-in, for
	 * any input. An answer marked `depends` can change with the input (their own thing, an
	 * exception of the action): `POST /api/v1/actions/{actionId}/check` gives the exact one.
	 */
	const myAccess = defineRoute({
		method: 'get',
		path: '/access',
		operationId: 'core.getAccess',
		summary:
			'What the signed-in member may do with each action (apply, suggest or not at all); `depends` answers can change with the input',
		requires: 'signedIn',
		response: z.object({ actions: z.record(z.string(), DecisionSchema) }),
		async handle(_ctx, { actor }) {
			return { actions: deps.runner().decisions(actor) };
		},
	});

	const listFeatures = defineRoute({
		method: 'get',
		path: '/features',
		operationId: 'core.listFeatures',
		summary: 'Extensions and whether each is turned on',
		requires: CORE_CAPABILITIES.featuresManage.id,
		response: z.array(z.object({ id: z.string(), enabled: z.boolean(), canDisable: z.boolean() })),
		async handle() {
			const features = deps.features();
			return deps.extensionIds().map((id) => ({
				id,
				enabled: features.isOn(id),
				canDisable: id !== 'core',
			}));
		},
	});

	const listAiAreas = defineRoute({
		method: 'get',
		path: '/ai-areas',
		operationId: 'core.listAiAreas',
		summary: 'Areas (extensions) and how far the AI may use each',
		requires: CORE_CAPABILITIES.aiManage.id,
		response: z.array(
			z.object({
				id: z.string(),
				sensitive: z.boolean(),
				/** It offers actions the AI can propose (other areas only matter if sensitive). */
				usesAi: z.boolean(),
				access: z.enum(AI_AREA_ACCESS),
				default: z.enum(AI_AREA_ACCESS),
			}),
		),
		async handle() {
			const areas = deps.aiAreas();
			return deps
				.extensions()
				.filter((e) => e.id !== 'core')
				.map((e) => ({
					id: e.id,
					sensitive: e.sensitive,
					usesAi: e.usesAi,
					access: areas.access(e.id),
					default: areas.defaultFor(e.id),
				}));
		},
	});

	const listMembers = defineRoute({
		method: 'get',
		path: '/members',
		operationId: 'core.listMembers',
		summary: 'Active family members',
		requires: CORE_CAPABILITIES.membersView.id,
		// How each person signs in: only for those who manage people.
		response: z.array(MemberSchema.extend({ signIn: SignInMethodsSchema.optional() })),
		async handle(ctx, { actor }) {
			const rows = await members(ctx.db)
				.selectFrom('core_members')
				.selectAll()
				.where('archived_at', 'is', null)
				.orderBy('created_at')
				.execute();
			// A display sees names and colors only: no role and no private notes.
			if (actor.kind === 'display')
				return rows.map((row) => ({ ...toMember(row), roleId: '', about: null }));
			if (!deps.access().can(actor, CORE_CAPABILITIES.membersManage.id)) return rows.map(toMember);
			const methods = await deps.identity.signInMethods();
			return rows.map((row) => ({ ...toMember(row), signIn: methods.get(row.id) ?? NO_SIGN_IN }));
		},
	});

	const listProfiles = defineRoute({
		method: 'get',
		path: '/profiles',
		operationId: 'core.listProfiles',
		summary: 'Profile picker for PIN sign-in (name and color only)',
		// Only trusted family devices (or signed-in members) see who lives here.
		requires: 'trusted-device',
		response: z.array(z.object({ id: z.string(), displayName: z.string(), color: z.string() })),
		async handle(ctx) {
			const rows = await members(ctx.db)
				.selectFrom('core_members')
				.select(['id', 'display_name', 'color', 'role_id'])
				.where('archived_at', 'is', null)
				.orderBy('created_at')
				.execute();
			// Only people who have a PIN, and whose role lets them use it, appear in the picker.
			const access = deps.access();
			const methods = await deps.identity.signInMethods();
			return rows
				.filter(
					(r) =>
						methods.get(r.id)?.pin === true &&
						access.effective(r.role_id).has(CORE_CAPABILITIES.signInPin.id),
				)
				.map((r) => ({ id: r.id, displayName: r.display_name, color: r.color }));
		},
	});

	const familyName = defineRoute({
		method: 'get',
		path: '/family-name',
		operationId: 'core.getFamilyName',
		summary: 'What the family is called, for the sign-in page of a family device',
		// A surname identifies the family: only trusted family devices (or signed-in members) get it.
		requires: 'trusted-device',
		response: z.object({ name: z.string().nullable() }),
		async handle(ctx) {
			return { name: (await ctx.family.settings()).name ?? null };
		},
	});

	const familySettings = defineRoute({
		method: 'get',
		path: '/settings/family',
		operationId: 'core.getFamilySettings',
		summary: 'Family time zone, default language and region formats',
		requires: 'signedIn',
		response: FamilySettingsSchema,
		async handle(ctx) {
			return ctx.family.settings();
		},
	});

	const listDevices = defineRoute({
		method: 'get',
		path: '/devices',
		operationId: 'core.listDevices',
		summary: 'Trusted family devices',
		requires: CORE_CAPABILITIES.devicesManage.id,
		response: z.array(DeviceSchema),
		async handle() {
			const devices = deps.devices();
			return (await devices.list()).map((row) => toDevice(row, devices.leftOut(row.id)));
		},
	});

	const currentDevice = defineRoute({
		method: 'get',
		path: '/devices/current',
		operationId: 'core.getCurrentDevice',
		summary: 'The trusted device this request comes from, if any',
		requires: 'public',
		response: z.object({ device: z.object({ id: z.string(), name: z.string() }).nullable() }),
		async handle(_ctx, { device }) {
			return { device };
		},
	});

	const MemberParams = z.object({ memberId: MemberIdSchema });

	/**
	 * Revokes the member's API tokens and enqueues the job that ends the extensions' credentials,
	 * in one transaction, before their sessions end: if it fails the sign-out does not happen and
	 * the person tries again, so nothing they meant to stop keeps working.
	 */
	const endCredentialsOf = (ctx: ExtensionContext, memberId: string) =>
		ctx.db.transaction().execute(async (trx) => {
			await revokeTokensOf(trx, memberId, ctx.clock.now());
			await deps.enqueueIn(trx, END_CREDENTIALS_JOB, { memberId });
		});

	/** Signs a member out everywhere and closes their open realtime connections at once. */
	const endSessionsOf = async (ctx: { events: EventBus }, memberId: string) => {
		await deps.identity.endSessions(memberId);
		await ctx.events.emit(sessionEnded, { memberId });
	};

	const setPin = defineRoute({
		method: 'put',
		path: '/members/{memberId}/pin',
		operationId: 'core.setMemberPin',
		summary: "Set a member's PIN login",
		requires: CORE_CAPABILITIES.membersManage.id,
		params: MemberParams,
		body: z.object({ pin: z.string().regex(/^\d{4,6}$/) }),
		response: z.object({ ok: z.literal(true) }),
		status: 200,
		async handle(ctx, { params, body, actor }) {
			const member = await findMember(ctx.db, params.memberId);
			// A custom role may be kept to passwords. (A PIN sign-in never administers, whatever the role.)
			if (!deps.access().effective(member.role_id).has(CORE_CAPABILITIES.signInPin.id)) {
				throw new FamosError('conflict', "This member's role signs in with a password, not a PIN");
			}
			await deps.identity.setPin({
				memberId: member.id,
				pin: body.pin,
				displayName: member.display_name,
			});
			await endSessionsOf(ctx, member.id);
			await deps.audit.record(actor, 'core.setMemberPin', member.id);
			return { ok: true as const };
		},
	});

	const setPassword = defineRoute({
		method: 'put',
		path: '/members/{memberId}/password',
		operationId: 'core.setMemberPassword',
		summary: "Set a member's email + password login",
		requires: CORE_CAPABILITIES.membersManage.id,
		params: MemberParams,
		body: z.object({ email: z.email(), password: z.string().min(10).max(200) }),
		response: z.object({ ok: z.literal(true) }),
		async handle(ctx, { params, body, actor }) {
			const member = await findMember(ctx.db, params.memberId);
			// The old password may be known to someone: what it made (keys, addresses) ends with it.
			await endCredentialsOf(ctx, member.id);
			await deps.identity.setPasswordLogin({
				memberId: member.id,
				...body,
				displayName: member.display_name,
			});
			// A new password signs the member out everywhere, except an admin changing their own.
			if (selfOf(actor) !== member.id) await endSessionsOf(ctx, member.id);
			await deps.audit.record(actor, 'core.setMemberPassword', member.id);
			return { ok: true as const };
		},
	});

	const signOutEverywhere = defineRoute({
		method: 'post',
		path: '/sessions/end',
		operationId: 'core.signOutEverywhere',
		summary: "End all of the caller's sessions, on every device",
		requires: 'signedIn',
		response: z.object({ ok: z.literal(true) }),
		status: 200,
		async handle(ctx, { actor }) {
			if (!personPresent(actor)) throw new FamosError('unauthenticated', 'Sign in required');
			// Keys and calendar addresses are sign-ins too: they end with the sessions.
			await endCredentialsOf(ctx, actor.memberId);
			await endSessionsOf(ctx, actor.memberId);
			await deps.audit.record(actor, 'core.signOutEverywhere', actor.memberId);
			return { ok: true as const };
		},
	});

	const listDrafts = defineRoute({
		method: 'get',
		path: '/drafts',
		operationId: 'core.listDrafts',
		summary: 'Drafts awaiting or past a decision',
		requires: CORE_CAPABILITIES.draftsPropose.id,
		query: z.object({
			status: z.enum(DRAFT_STATUSES).optional(),
			/** Only drafts proposed from this source, e.g. `inbox`. */
			sourceKind: z.string().max(40).optional(),
			sourceId: z.string().max(80).optional(),
			limit: z.coerce.number().int().min(1).max(200).default(50),
		}),
		response: z.array(DraftSchema),
		async handle(ctx, { query, actor }) {
			let q = ctx.db.withTables<CoreTables>().selectFrom('core_drafts').selectAll();
			// Drafts addressed to one member (memory, questions) are visible to them alone.
			const self = selfOf(actor);
			q = q.where((eb) =>
				self !== null
					? eb.or([eb('for_member', 'is', null), eb('for_member', '=', self)])
					: eb('for_member', 'is', null),
			);
			// A waiting draft about a day that has passed is expired, even before the daily job.
			if (query.status === 'expired') q = q.where('status', 'in', ['expired', ...WAITING_STATUSES]);
			else if (query.status) q = q.where('status', '=', query.status);
			if (query.sourceKind) q = q.where('source_kind', '=', query.sourceKind);
			if (query.sourceId) q = q.where('source_id', '=', query.sourceId);
			// A member reads the suggestions they may decide or are the person behind, never
			// another member's (a supervised child's appointment is not for a teenager to see).
			const runner = deps.runner();
			const readable = (row: DraftRow) =>
				!personPresent(actor) ||
				runner.mayDecide(row, actor) ||
				runner.isProposer(actor, row) ||
				// Whoever would have decided it sees why it waits.
				(runner.unavailable(row) !== null &&
					deps.access().can(actor, CORE_CAPABILITIES.draftsApprove.id));
			// Newest first, a page at a time: only as many drafts are read as it takes to fill the
			// answer with ones this reader may see.
			const page = Math.max(50, query.limit * 2);
			const rows: DraftRow[] = [];
			let after: { created_at: number; id: string } | null = null;
			for (;;) {
				const before = after;
				const batch: DraftRow[] = await (before
					? q.where((eb) =>
							eb.or([
								eb('created_at', '<', before.created_at),
								eb.and([eb('created_at', '=', before.created_at), eb('id', '<', before.id)]),
							]),
						)
					: q
				)
					.orderBy('created_at', 'desc')
					.orderBy('id', 'desc')
					.limit(page)
					.execute();
				for (const row of batch) {
					if (rows.length < query.limit && readable(row)) rows.push(row);
				}
				if (rows.length >= query.limit || batch.length < page) break;
				after = batch.at(-1) ?? null;
			}
			const passed = await runner.passedCheck();
			// What it is about is gone: it can never be applied, so it is closed like an expired one.
			const gone = await runner.goneAmong(rows.filter((row) => !passed(row)));
			const shown = rows
				.map(
					(row): DraftRow =>
						passed(row) || gone.has(row.id) ? { ...row, status: 'expired' } : row,
				)
				.filter((row) => !query.status || row.status === query.status);
			return Promise.all(shown.map((row) => view(row, actor, gone.has(row.id))));
		},
	});

	const countWaiting = defineRoute({
		method: 'get',
		path: '/drafts/waiting',
		operationId: 'core.countWaitingDrafts',
		summary:
			'How many suggestions wait for a decision (a count only): what Quick add shows to decide',
		requires: CORE_CAPABILITIES.draftsWaiting.id,
		response: z.object({ count: z.number().int() }),
		async handle(ctx, { actor }) {
			// Drafts addressed to a member count for them alone (never for displays or others).
			const rows = await ctx.db
				.withTables<CoreTables>()
				.selectFrom('core_drafts')
				// Only what deciding, expiry, a gone target and grouping look at: never the texts.
				.select([
					'id',
					'action_id',
					'status',
					'input',
					'edited_input',
					'for_member',
					'proposed_by',
					'source_kind',
					'source_id',
				])
				// A suggestion whose applying failed still waits for someone to try it again.
				.where('status', 'in', [...WAITING_STATUSES])
				.where((eb) => {
					const self = selfOf(actor);
					return self !== null
						? eb.or([eb('for_member', 'is', null), eb('for_member', '=', self)])
						: eb('for_member', 'is', null);
				})
				.execute();
			// A member's count is what they can decide: not their own suggestions, nor what an
			// approver must look at. A display only shows that something waits.
			const decidable = personPresent(actor)
				? rows.filter((row) => deps.runner().mayDecide(row, actor))
				: rows;
			// One about a day that has passed no longer waits (it expires).
			const passed = await deps.runner().passedCheck();
			const open = decidable.filter((row) => !passed(row));
			// One whose target is gone can never be applied: nothing to decide.
			const gone = await deps.runner().goneAmong(open);
			// What a member shared is one thing to decide, however many suggestions it made.
			return { count: new Set(open.filter((row) => !gone.has(row.id)).map(waitingUnit)).size };
		},
	});

	/**
	 * Which of a source's items have a suggestion waiting that the signed-in member may decide
	 * (theirs alone, or one they could approve). Lets an extension show an item to the people who
	 * must decide it without reading the drafts table. Not offered to any model.
	 */
	const decidableSources = defineAction({
		id: 'core.decidableSources',
		title: 'Which items of a source have a suggestion the member may decide',
		input: z.object({ sourceKind: z.string().min(1).max(40) }),
		output: z.object({ sourceIds: z.array(z.string()) }),
		readOnly: true,
		async run(uow, { sourceKind }) {
			const self = selfOf(uow.actor);
			if (self === null) return { sourceIds: [] };
			const rows = await uow.db
				.withTables<CoreTables>()
				.selectFrom('core_drafts')
				.selectAll()
				.where('source_kind', '=', sourceKind)
				.where('status', 'in', ['pending', 'failed'])
				.where((eb) => eb.or([eb('for_member', 'is', null), eb('for_member', '=', self)]))
				.execute();
			const ids = new Set<string>();
			const passed = await deps.runner().passedCheck(uow.db);
			const gone = await deps.runner().goneAmong(rows, uow.db);
			for (const row of rows) {
				if (passed(row) || gone.has(row.id)) continue;
				if (row.source_id && deps.runner().mayDecide(row, uow.actor)) ids.add(row.source_id);
			}
			return { sourceIds: [...ids] };
		},
	});

	/**
	 * Where "now" is for the family: the date, the weekday, the time and this week's first and last
	 * day. An agent that never saw the server's instructions (an MCP client) cannot know the date,
	 * and models count days badly, so they ask.
	 */
	const today = defineAction({
		id: 'core.today',
		title: 'Today’s date, weekday and time in the family’s time zone',
		input: z.object({}),
		output: z.object({
			date: z.string().describe('Today, YYYY-MM-DD'),
			weekday: z.string(),
			time: z.string().describe('The time of day now, HH:MM (24-hour)'),
			timeZone: z.string(),
			weekFirstDay: z.string().describe('The first day of this week, YYYY-MM-DD'),
			weekLastDay: z.string().describe('The last day of this week, YYYY-MM-DD'),
			thisWeek: z
				.object({ from: z.string(), to: z.string() })
				.describe(
					'What "this week" means when someone asks: today to the week\u2019s last day, or the coming seven days when today is the last day. YYYY-MM-DD',
				),
			thisWeekNote: z
				.string()
				.nullable()
				.describe('Set when "this week" was asked on the week\u2019s last day'),
			nextWeek: z
				.object({ from: z.string(), to: z.string() })
				.describe('"Next week": the whole week after this one, YYYY-MM-DD'),
			days: z
				.array(z.string())
				.describe(
					'The days from a week ago to two weeks ahead, each with its weekday ("Tue 2026-10-13 (today)"). Take weekdays from here; when a weekday and a date disagree, say so and ask.',
				),
		}),
		readOnly: true,
		ai: {
			description:
				'Tells today’s date, the weekday, the time of day, the family time zone, the first and last day of this week (the week starts on the family’s first day of the week), and the weekday of each day from a week ago to two weeks ahead. Use it before turning "today", "tomorrow", "this week" or "next Friday" into dates.',
		},
		async run(uow) {
			const { timeZone, weekStart } = await uow.family.settings();
			const now = uow.clock.now();
			const date = todayIn(timeZone, now);
			const week = weekOf(date, weekStart);
			const thisWeek = resolveSpan({ kind: 'week' }, date, weekStart);
			const nextWeek = resolveSpan({ kind: 'next' }, date, weekStart);
			return {
				date,
				weekday: formatDate(date, 'en', { weekday: 'long' }),
				time: zoned(now, timeZone).toPlainTime().toString({ smallestUnit: 'minute' }),
				timeZone,
				weekFirstDay: week[0] as string,
				weekLastDay: week[6] as string,
				thisWeek: { from: thisWeek?.from ?? date, to: thisWeek?.to ?? (week[6] as string) },
				thisWeekNote:
					thisWeek?.label.key === 'coming_days'
						? 'Asked on the week\u2019s last day, "this week" means the coming seven days.'
						: null,
				nextWeek: { from: nextWeek?.from ?? date, to: nextWeek?.to ?? date },
				days: daysAround(date),
			};
		},
	});

	/**
	 * What a draft is about, by name. A draft stored before drafts carried the real title of what
	 * they change names its target only by id: the action says what that is called now, read from
	 * its own extension's tables through this transaction.
	 */
	const draftSubject = async (uow: UnitOfWork, row: DraftRow) => {
		const raw = row.edited_input ?? row.input;
		const named = subjectOf(raw);
		const def = deps.registry().actions.get(row.action_id);
		const look = def?.targetTitle ?? def?.subject;
		if (named || !def || !look) return named;
		try {
			const input = def.input.safeParse(readStoredInput(def, raw));
			const ctx = {
				db: deps.extensionDb(ownerOf(def.id), uow.db),
				family: uow.family,
				translate: uow.translate,
				vocabulary: uow.vocabulary,
				now: uow.clock.now(),
			};
			return input.success ? ((await look(ctx, input.data)) ?? undefined)?.slice(0, 80) : undefined;
		} catch {
			return undefined;
		}
	};

	/**
	 * What became of suggestions, so an agent answers "was it approved?" instead of guessing. An
	 * agent working in a conversation (the assistant in one thread, an MCP client with its app key)
	 * sees only the suggestions made there: the person's other suggestions, from Quick add or
	 * another app, are not its doing. A member asking directly sees all of their own. Only the
	 * person's own suggestions are listed, and one addressed to someone else never is.
	 */
	const mySuggestions = defineAction({
		id: 'core.mySuggestions',
		title: "Read the status of the member's recent suggestions",
		input: z.object({ limit: z.number().int().min(1).max(30).default(15) }),
		output: z.object({
			suggestions: z.array(
				z.object({
					id: z.string(),
					/** What this suggestion is: the action and the thing it is about. */
					label: z.string(),
					/** The Quick add group it came from, when it came from one (not a name for this suggestion). */
					group: z.string().optional(),
					status: z.enum(['waiting', 'approved', 'rejected', 'undone', 'expired', 'failed']),
					/** Why a rejected suggestion closed: taken back by the person, its subject is gone, or it was already so. */
					reason: z.enum(['withdrawn', 'gone', 'settled']).optional(),
					/** When it was suggested and, once decided, when; ISO 8601 UTC. */
					suggestedAt: z.string(),
					decidedAt: z.string().optional(),
					/**
					 * The name of the person who decided it (approved, rejected or took it back), as
					 * people call them: an agent repeats it, so it is never an id or a handle.
					 */
					decidedBy: z.string().optional(),
					/** Approved by the household's auto-approval setting, not by a person deciding it. */
					automatic: z.literal(true).optional(),
				}),
			),
		}),
		readOnly: true,
		ai: {
			description:
				"Lists the suggestions made in this conversation (the changes you proposed here for the person; for a connected app, the ones made through its app key), newest first, with what became of each: waiting, approved, rejected (withdrawn when the person took it back), undone, expired or failed, and who decided it (decidedBy, the person's name; automatic when the household's auto-approval approved it). Suggestions made elsewhere (Quick add, other conversations or apps) are not listed: never present them as made here. Use it when the person asks whether something was approved or added, or what is still waiting.",
		},
		async run(uow, { limit }) {
			const owner = memberBehind(uow.actor);
			if (owner === null) return { suggestions: [] };
			const rows = await uow.db
				.withTables<CoreTables>()
				.selectFrom('core_drafts')
				.selectAll()
				.where((eb) => eb.or([eb('for_member', 'is', null), eb('for_member', '=', owner)]))
				.orderBy('created_at', 'desc')
				.limit(MY_SUGGESTIONS_WINDOW)
				.execute();
			const passed = await deps.runner().passedCheck(uow.db);
			const actions = deps.registry().actions;
			const iso = (at: number) => new Date(at).toISOString();
			// An action's title is read from its own extension's tables, through this transaction.
			const ctxOf = (def: AnyActionDefinition) => ({
				db: deps.extensionDb(ownerOf(def.id), uow.db),
				family: uow.family,
				translate: uow.translate,
				vocabulary: uow.vocabulary,
				now: uow.clock.now(),
			});
			const actor = uow.actor;
			// An agent in a conversation: what was suggested there (an MCP draft also names its app
			// key as its source).
			const here =
				actor.kind === 'ai' && actor.sourceId !== undefined
					? (row: DraftRow, by: Actor) =>
							(by.kind === 'ai' && by.source === actor.source && by.sourceId === actor.sourceId) ||
							(row.source_kind === actor.source && row.source_id === actor.sourceId)
					: () => true;
			const mine = rows
				.filter((row) => {
					const by = JSON.parse(row.proposed_by) as Actor;
					const theirs = memberBehind(by) === owner;
					return theirs && here(row, by);
				})
				.slice(0, limit);
			const subjectFor = (row: DraftRow) => draftSubject(uow, row);
			// A change to one date of a repeating event says so, in the words and the date format
			// of the person it is for.
			const { locale, formatLocale, hourCycle } = await uow.family.settings();
			const language = (await uow.family.members()).find((m) => m.id === owner)?.locale ?? locale;
			const scopeFor = async (row: DraftRow) => {
				const def = actions.get(row.action_id);
				if (!def?.scopeNote) return undefined;
				try {
					const input = def.input.safeParse(readStoredInput(def, row.edited_input ?? row.input));
					const note = input.success ? await def.scopeNote(ctxOf(def), input.data) : null;
					return note
						? uow.translate(language, note.key, {
								date: formatDate(note.date, dateLocale(language, formatLocale, hourCycle), {
									day: 'numeric',
									month: 'short',
								}),
							})
						: undefined;
				} catch {
					return undefined;
				}
			};
			// Who decided, by name: an archived member still decided it, so the table is read.
			const deciders = [
				...new Set(mine.flatMap((row) => (row.decided_by === null ? [] : [row.decided_by]))),
			];
			const names = new Map(
				deciders.length === 0
					? []
					: (
							await members(uow.db)
								.selectFrom('core_members')
								.select(['id', 'display_name'])
								.where('id', 'in', deciders)
								.execute()
						).map((m) => [m.id, m.display_name]),
			);
			const goneIds = await deps.runner().goneAmong(
				mine.filter((row) => !passed(row)),
				uow.db,
			);
			const suggestions = await Promise.all(
				mine.map(async (row) => {
					const reason = goneIds.has(row.id) ? ('gone' as const) : draftReason(row);
					return {
						id: row.id,
						label: suggestionLabel(
							actions.get(row.action_id)?.title,
							row,
							await subjectFor(row),
							await scopeFor(row),
						),
						...(row.summary && { group: row.summary }),
						status: SUGGESTION_STATUS[passed(row) || goneIds.has(row.id) ? 'expired' : row.status],
						...(reason !== null && { reason }),
						suggestedAt: iso(row.created_at),
						...(row.decided_at !== null && { decidedAt: iso(row.decided_at) }),
						...(row.decided_by !== null &&
							names.has(row.decided_by) && { decidedBy: names.get(row.decided_by) }),
						...(row.auto_approved === 1 && { automatic: true as const }),
					};
				}),
			);
			return { suggestions };
		},
	});

	/**
	 * The suggestions waiting for the person asking: those they may decide (Quick add's cards,
	 * requests from others), wherever they were made, and their own that wait for someone else.
	 * A suggestion waits now, whatever days are asked about, so the span and the people asked about
	 * never leave one out; each stands on the span's first day it is asked about, and says the day
	 * it is about when it is about one. One the AI may not read (its area is off for it, or local
	 * only and the model is not) is counted as hidden, never shown.
	 */
	const suggestionsDigest = defineDigest({
		id: 'core.suggestionsDigest',
		topic: 'suggestions',
		title: 'Suggestions waiting for the person asking, for an answer',
		description:
			'The suggestions that wait for the person asking to approve or reject (Quick add cards, requests from others), newest first, and their own suggestions that wait for someone else; who suggested each, and the day it is about.',
		async run(uow, input) {
			const actor = uow.actor;
			const asker = memberBehind(actor);
			if (asker === null) return digestOf([], input);
			const [settings, people] = await Promise.all([uow.family.settings(), uow.family.members()]);
			const me = people.find((m) => m.id === asker);
			// Past the check above the caller is a member or an AI working for one, which both carry
			// the role they act with.
			const roleId = 'roleId' in actor ? actor.roleId : undefined;
			const role =
				roleId ??
				(
					await members(uow.db)
						.selectFrom('core_members')
						.select('role_id')
						.where('id', '=', asker)
						.executeTakeFirst()
				)?.role_id;
			if (role === undefined) return digestOf([], input);
			const person: Actor = { kind: 'member', memberId: asker, roleId: role };
			const rows = await uow.db
				.withTables<CoreTables>()
				.selectFrom('core_drafts')
				.selectAll()
				.where('status', 'in', [...WAITING_STATUSES])
				.where((eb) => eb.or([eb('for_member', 'is', null), eb('for_member', '=', asker)]))
				.orderBy('created_at', 'desc')
				.orderBy('id', 'desc')
				.limit(MY_SUGGESTIONS_WINDOW)
				.execute();
			const runner = deps.runner();
			const passed = await runner.passedCheck(uow.db);
			const actions = deps.registry().actions;
			const areas = deps.aiAreas();
			// What the AI may not look into stays out of what it reads, even counted as a title.
			const aiMayRead = (row: DraftRow) => {
				if (actor.kind !== 'ai') return true;
				const area = areas.access(ownerOf(row.action_id));
				return area === 'any' || (area === 'local' && actor.local === true);
			};
			const today = todayIn(settings.timeZone, uow.clock.now());
			const date = today < input.from ? input.from : today > input.to ? input.to : today;
			const language = me?.locale ?? settings.locale;
			const gone = await runner.goneAmong(rows, uow.db);
			const waiting = rows.filter(
				(row) =>
					!passed(row) &&
					!gone.has(row.id) &&
					(runner.mayDecide(row, person) || runner.isProposer(person, row)),
			);
			const readable = waiting.filter(aiMayRead);
			const items = await Promise.all(
				readable.map(async (row): Promise<DigestItem> => {
					const def = actions.get(row.action_id);
					const by = JSON.parse(row.proposed_by) as Actor;
					const from = memberBehind(by);
					const name = def?.draftTitle ? uow.translate(language, def.draftTitle) : def?.title;
					const day = def ? draftDateOf(def, row) : undefined;
					return {
						handle: row.id,
						kind: 'suggestion',
						title: suggestionLabel(name, row, await draftSubject(uow, row)).slice(0, 300),
						date,
						people: from ? [from] : [],
						status: row.status === 'failed' ? 'failed' : 'waiting',
						extra: {
							waitsFor: runner.mayDecide(row, person) ? 'asker' : 'others',
							suggestedOn: zoned(row.created_at, settings.timeZone).toPlainDate().toString(),
							...(day && { day }),
							...(row.summary && { group: row.summary.slice(0, 300) }),
						},
					};
				}),
			);
			return digestOf(items, input, {
				limit: SUGGESTIONS_DIGEST_LIMIT,
				hidden: waiting.length - readable.length,
			});
		},
	});

	const endCredentials = defineJob({
		name: END_CREDENTIALS_JOB,
		payload: z.object({ memberId: z.string() }),
		maxAttempts: 10,
		timeoutMs: 30_000,
		backoff: (attempt) => Math.min(60_000, 2_000 * 2 ** (attempt - 1)),
		async handle(ctx, { memberId }) {
			// Again, in case a token was made between the change and now.
			await revokeTokensOf(ctx.db, memberId, ctx.clock.now());
			for (const ext of deps.registry().extensions)
				await ext.endCredentials?.(deps.jobContext(ext.id), memberId);
		},
	});

	const expireDrafts = defineJob({
		name: EXPIRE_JOB,
		payload: z.object({}),
		maxAttempts: 3,
		async handle(ctx) {
			const count = await deps.runner().expirePassed();
			if (count > 0) ctx.logger.info({ count }, 'suggestions about a passed day expired');
			await scheduleExpiry(ctx);
		},
	});

	const DraftParams = z.object({ draftId: idSchema('draft') });

	const editDraft = defineAction({
		id: 'core.editDraft',
		title: 'Save a change to a waiting suggestion',
		input: z.object({ draftId: idSchema('draft'), input: z.unknown() }),
		output: z.object({ draftId: z.string(), editedInput: z.unknown() }),
		// The runner decides who may: whoever may decide the suggestion, or the member behind it.
		requires: CORE_CAPABILITIES.draftsPropose.id,
		approval: 'never',
		async run(uow, { draftId, input }) {
			const row = await deps.runner().editDraft(uow, draftId, input);
			return {
				draftId,
				editedInput: row.edited_input === null ? null : JSON.parse(row.edited_input),
			};
		},
	});
	const unavailableOf = (row: DraftRow): z.infer<typeof DraftSchema>['unavailable'] => {
		if (row.status !== 'pending' && row.status !== 'failed') return null;
		const why = deps.runner().unavailable(row);
		if (!why) return null;
		return { ...why, labels: deps.extensionInstall.namesOf(why.extension) };
	};
	const view = async (row: DraftRow, reader: Actor, waitingGone = false) =>
		toDraft(
			row,
			deps.runner().undoStep(row) !== null,
			await deps.runner().mayExist(row),
			deps.registry().actions.get(row.action_id)?.draftTitle ?? null,
			await deps.runner().alternative(row),
			deps.runner().mayDecide(row, reader),
			await deps.runner().currentValues(row),
			await deps.runner().subject(row),
			await deps.runner().suggestedAgain(row),
			(json) => readStoredInput(deps.registry().actions.get(row.action_id), json),
			unavailableOf(row),
			waitingGone,
			await deps.runner().appBehind(row),
		);

	const approve = defineRoute({
		method: 'post',
		path: '/drafts/{draftId}/approve',
		operationId: 'core.approveDraft',
		summary: 'Approve (optionally edit) and apply a draft',
		// The runner decides who may: an approver, or the member a draft is addressed to.
		requires: CORE_CAPABILITIES.draftsPropose.id,
		params: DraftParams,
		body: z.object({ input: z.unknown().optional() }),
		response: DraftSchema,
		async handle(_ctx, { params, body, actor }) {
			return view(await deps.runner().approveDraft(params.draftId, actor, body.input), actor);
		},
	});

	const reject = defineRoute({
		method: 'post',
		path: '/drafts/{draftId}/reject',
		operationId: 'core.rejectDraft',
		summary: 'Reject a draft, or withdraw your own',
		requires: CORE_CAPABILITIES.draftsPropose.id,
		params: DraftParams,
		response: DraftSchema,
		async handle(_ctx, { params, actor }) {
			return view(await deps.runner().rejectDraft(params.draftId, actor), actor);
		},
	});

	const undo = defineRoute({
		method: 'post',
		path: '/drafts/{draftId}/undo',
		operationId: 'core.undoDraft',
		summary: "Take back an applied draft (Undo), with its action's inverse",
		requires: CORE_CAPABILITIES.draftsPropose.id,
		params: DraftParams,
		response: DraftSchema,
		async handle(_ctx, { params, actor }) {
			return view(await deps.runner().undoDraft(params.draftId, actor), actor);
		},
	});

	const suggestAgain = defineRoute({
		method: 'post',
		path: '/drafts/{draftId}/suggest-again',
		operationId: 'core.suggestDraftAgain',
		summary: 'Suggest an undone draft again, as a new waiting draft (only the person behind it)',
		requires: CORE_CAPABILITIES.draftsPropose.id,
		params: DraftParams,
		response: DraftSchema,
		async handle(_ctx, { params, actor }) {
			return view(await deps.runner().suggestAgain(params.draftId, actor), actor);
		},
	});

	const replace = defineRoute({
		method: 'post',
		path: '/drafts/{draftId}/replace',
		operationId: 'core.replaceDraft',
		summary: 'Turn a pending draft into the alternative it offers (`instead`)',
		// The runner decides who may: whoever may decide both the draft and what it becomes.
		requires: CORE_CAPABILITIES.draftsPropose.id,
		params: DraftParams,
		response: DraftSchema,
		async handle(_ctx, { params, actor }) {
			return view(await deps.runner().replaceDraft(params.draftId, actor), actor);
		},
	});

	return defineExtension({
		// Core is the host itself, not an installed package, so its manifest is written here.
		manifest: {
			id: 'core',
			version: SDK_VERSION,
			sdk: `^${SDK_VERSION}`,
			capabilities: Object.values(CORE_CAPABILITIES).map((c) => c.id),
			// Language and theme packs can be installed from an address a person types.
			network: { userUrls: true },
		},
		migrations: coreMigrations,
		actions: [
			decidableSources,
			editDraft,
			mySuggestions,
			suggestionsDigest,
			today,
			createMember,
			updateMember,
			setMyLanguage,
			setMyNextUp,
			archiveMember,
			setFeatureEnabled,
			setAiAreaAccess,
			updateFamilySettings,
			setFamilyName,
			...languages.actions,
			...deps.themes.actions,
			createRole,
			updateRole,
			deleteRole,
			...autoApproval.actions,
			...deps.notifications.actions,
			...deps.search.actions,
			...memory.actions,
			...admin.actions,
			...createAiSettingsActions({ settings: deps.aiSettings }),
			...createChannelActions({
				backups: deps.backupSettings,
				email: deps.emailSettings,
				telegram: deps.telegramLinks,
			}),
			...deps.extensionInstall.actions,
		],
		jobs: [
			...languages.jobs,
			...deps.themes.jobs,
			...deps.notifications.jobs,
			...autoApproval.jobs,
			pruneIdempotency,
			oauthCleanup,
			pruneChanges,
			expireDrafts,
			endCredentials,
			...admin.jobs,
			...deps.search.jobs,
			...deps.extensionInstall.jobs,
		],
		notifications: [
			draftWaiting,
			draftDecided,
			backupFailed,
			backupRestored,
			...oauthNotifications,
			...autoApproval.notifications,
		],
		capabilities: Object.values(CORE_CAPABILITIES),
		routes: [
			listRoles,
			setupStatus,
			setup,
			me,
			myAccess,
			listFeatures,
			listAiAreas,
			listMembers,
			listProfiles,
			familyName,
			familySettings,
			listDevices,
			currentDevice,
			setPin,
			setPassword,
			signOutEverywhere,
			listDrafts,
			countWaiting,
			approve,
			reject,
			undo,
			suggestAgain,
			replace,
			...languages.routes,
			...deps.themes.routes,
			...autoApproval.routes,
			...deps.notifications.routes,
			...deps.search.routes,
			...memory.routes,
			...deps.extensionInstall.routes,
		],
		events: [
			...coreEvents,
			...languages.events,
			...deps.themes.events,
			...deps.extensionInstall.events,
		],
		register: async (ctx) => {
			// First pruning a day after start; the job schedules the next one itself.
			await schedulePrune(ctx, ctx.clock.now() + DAY_MS);
			await scheduleOAuthCleanup(ctx, ctx.clock.now() + DAY_MS);
			await schedulePruneChanges(ctx, ctx.clock.now() + DAY_MS);
			// Suggestions about a day that has passed expire shortly after midnight (family time).
			await scheduleExpiry(ctx);
		},
	});
}
