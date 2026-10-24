import {
	type Actor,
	APP_MODES,
	type AppMode,
	assertFullSignIn,
	type Clock,
	DAY_MS,
	type DbExecutor,
	FamosError,
	HOUR_MS,
	type IdGenerator,
	type MemberId,
	type RoleId,
	selfOf,
} from '@famos/sdk';
import type { Access } from './access.ts';
import { API_TOKEN_PREFIX } from './api-tokens.ts';
import { CORE_CAPABILITIES } from './core-capabilities.ts';
import { randomSecret, sha256Hex } from './secret-text.ts';
import type { AppRow, AppTokenRow, CoreTables } from './tables.ts';

/** Most keys one app has live at once: a rotation needs two, not twenty. */
const MAX_TOKENS_PER_APP = 5;
const MAX_APPS = 50;
const MAX_ACTS_FOR = 50;
const SEEN_RESOLUTION_MS = HOUR_MS;
/** The header an app names the member it acts for with. */
export const ON_BEHALF_OF_HEADER = 'x-familyos-on-behalf-of';
/** Keys are long-lived: no expiry unless the admin sets one, and at most ten years. */
export const APP_TOKEN_MAX_DAYS = 3650;
/** How long before an expiry the page warns. */
export const APP_TOKEN_WARN_DAYS = 14;

export type AppTokenView = {
	id: string;
	appId: string;
	name: string;
	expiresAt: number | null;
	lastUsedAt: number | null;
	createdAt: number;
	revokedAt: number | null;
};

export type AppView = {
	id: string;
	name: string;
	roleId: RoleId;
	mode: AppMode;
	actsFor: string[];
	createdBy: string | null;
	createdAt: number;
	updatedAt: number;
	revokedAt: number | null;
	pausedAt: number | null;
	/** The latest use of any of its keys. */
	lastUsedAt: number | null;
	tokens: AppTokenView[];
};

export type AppInput = {
	name: string;
	roleId: RoleId;
	mode: AppMode;
	actsFor: readonly string[];
};

/** Who a key stands for once it is accepted. */
export type AppCaller = {
	actor: Actor;
	app: { id: string; name: string };
	tokenId: string;
	/** The member it acts for, when the request named one. */
	memberId: string | null;
	/** Every member on the app's list, active or not; callers narrow it to the active ones. */
	actsFor: string[];
};

/**
 * Connected apps: an admin registers a program with a role, a mode and the members it may act
 * for, and gives it keys (hashed, shown once, long-lived, rotated by overlap). Only a person who
 * signed in with a password and holds `core.apps.manage` manages them. Minting a key returns its
 * secret once, so it stays outside actions (an action's answer is kept for replays); the app
 * itself, its changes and every revocation run as core actions through `in(uow.db)`.
 */
export interface AppService {
	/** The same service on another executor: an action's unit of work, so it commits with it. */
	in(db: DbExecutor): AppService;
	list(actor: Actor): Promise<AppView[]>;
	/** Registers the app without a key; its first key is minted with `createToken`. */
	create(actor: Actor, input: AppInput): Promise<AppView>;
	update(actor: Actor, appId: string, input: Partial<AppInput>): Promise<AppView>;
	pause(actor: Actor, appId: string): Promise<AppView>;
	resume(actor: Actor, appId: string): Promise<AppView>;
	/** Revokes the app and all its keys for good. */
	revoke(actor: Actor, appId: string): Promise<AppView>;
	createToken(
		actor: Actor,
		appId: string,
		input: { name: string; expiresInDays?: number },
	): Promise<{ secret: string; token: AppTokenView }>;
	revokeToken(actor: Actor, appId: string, tokenId: string): Promise<AppTokenView>;
	/**
	 * Who a key is, or null when it is unknown, revoked, expired, or its app is revoked or paused.
	 * `onBehalfOf` is the member the request names: it must be on the app's list and active, or
	 * the call throws `forbidden` (the app's own role keeps working without it). Changes nothing:
	 * a use that is then refused must not look like a use.
	 */
	authenticate(
		secret: string | null | undefined,
		onBehalfOf?: string | null,
	): Promise<AppCaller | null>;
	/**
	 * Whether the key is one that would be valid but for its app being paused. Only a live key of
	 * a live, paused app answers true, so an unknown, revoked or expired key tells nothing.
	 */
	isPaused(secret: string | null | undefined): Promise<boolean>;
	/** Records a permitted use (`lastUsedAt`), at most hourly. */
	touch(tokenId: string): Promise<void>;
}

const tokenView = (row: AppTokenRow): AppTokenView => ({
	id: row.id,
	appId: row.app_id,
	name: row.name,
	expiresAt: row.expires_at,
	lastUsedAt: row.last_used_at,
	createdAt: row.created_at,
	revokedAt: row.revoked_at,
});

const actsForOf = (row: AppRow): string[] => {
	try {
		const parsed: unknown = JSON.parse(row.acts_for);
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
	} catch {
		return [];
	}
};

const appView = (row: AppRow, tokens: AppTokenRow[]): AppView => ({
	id: row.id,
	name: row.name,
	roleId: row.role_id,
	mode: row.mode,
	actsFor: actsForOf(row),
	createdBy: row.created_by,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
	revokedAt: row.revoked_at,
	pausedAt: row.paused_at,
	lastUsedAt: tokens.reduce<number | null>(
		(latest, t) =>
			t.last_used_at !== null && (latest === null || t.last_used_at > latest)
				? t.last_used_at
				: latest,
		null,
	),
	tokens: tokens.map(tokenView),
});

/** Pauses every live app; a restore does it, so an admin looks before a key works again. */
export async function pauseAllApps(db: DbExecutor, now: number): Promise<number> {
	const result = await db
		.withTables<CoreTables>()
		.updateTable('core_apps')
		.set({ paused_at: now })
		.where('revoked_at', 'is', null)
		.where('paused_at', 'is', null)
		.executeTakeFirst();
	return Number(result.numUpdatedRows);
}

export function createAppService(deps: {
	db: DbExecutor;
	clock: Clock;
	ids: IdGenerator;
	access: () => Access;
}): AppService {
	const t = () => deps.db.withTables<CoreTables>();

	/** Only an admin who signed in with a password manages apps: they hand out credentials. */
	function manager(actor: Actor): void {
		assertFullSignIn(actor);
		if (!deps.access().can(actor, CORE_CAPABILITIES.appsManage.id))
			throw new FamosError('forbidden', 'Not allowed to manage connected apps', {
				reason: 'capability',
				capability: CORE_CAPABILITIES.appsManage.id,
			});
	}

	function checkName(name: string): string {
		const clean = name.trim().slice(0, 60);
		if (!clean) throw new FamosError('bad_request', 'A name is needed');
		return clean;
	}

	function checkRole(roleId: string): void {
		const access = deps.access();
		if (!access.isBuiltIn(roleId) && !access.customRoles().some((r) => r.id === roleId))
			throw new FamosError('bad_request', 'Unknown role');
	}

	async function checkActsFor(ids: readonly string[]): Promise<string[]> {
		const unique = [...new Set(ids)];
		if (unique.length > MAX_ACTS_FOR) throw new FamosError('bad_request', 'Too many members');
		if (unique.length === 0) return [];
		const found = await t()
			.selectFrom('core_members')
			.select('id')
			.where('id', 'in', unique)
			.where('archived_at', 'is', null)
			.execute();
		if (found.length !== unique.length) throw new FamosError('bad_request', 'Unknown member');
		return unique;
	}

	function checkDays(days: number | undefined): number | null {
		if (days === undefined) return null;
		if (!Number.isInteger(days) || days < 1 || days > APP_TOKEN_MAX_DAYS)
			throw new FamosError('bad_request', `A key lasts between 1 and ${APP_TOKEN_MAX_DAYS} days`);
		return days;
	}

	async function load(appId: string): Promise<AppRow> {
		const row = await t()
			.selectFrom('core_apps')
			.selectAll()
			.where('id', '=', appId)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', 'App not found');
		return row;
	}

	async function viewOf(appId: string): Promise<AppView> {
		const row = await load(appId);
		const tokens = await t()
			.selectFrom('core_app_tokens')
			.selectAll()
			.where('app_id', '=', appId)
			.orderBy('created_at', 'desc')
			.orderBy('id', 'desc')
			.execute();
		return appView(row, tokens);
	}

	async function mint(appId: string, name: string, days: number | null) {
		const secret = `${API_TOKEN_PREFIX}${randomSecret()}`;
		const now = deps.clock.now();
		const row: AppTokenRow = {
			id: deps.ids.next('app_token'),
			app_id: appId,
			name,
			token_hash: await sha256Hex(secret),
			expires_at: days === null ? null : now + days * DAY_MS,
			last_used_at: null,
			created_at: now,
			revoked_at: null,
		};
		await t().insertInto('core_app_tokens').values(row).execute();
		return { secret, token: tokenView(row) };
	}

	async function live(appId: string): Promise<AppRow> {
		const row = await load(appId);
		if (row.revoked_at !== null) throw new FamosError('conflict', 'This app was revoked');
		return row;
	}

	return {
		in: (db) => createAppService({ ...deps, db }),

		async list(actor) {
			manager(actor);
			const apps = await t()
				.selectFrom('core_apps')
				.selectAll()
				.orderBy('created_at', 'desc')
				.orderBy('id', 'desc')
				.execute();
			const tokens = await t()
				.selectFrom('core_app_tokens')
				.selectAll()
				.orderBy('created_at', 'desc')
				.orderBy('id', 'desc')
				.execute();
			return apps.map((app) =>
				appView(
					app,
					tokens.filter((tk) => tk.app_id === app.id),
				),
			);
		},

		async create(actor, input) {
			manager(actor);
			const name = checkName(input.name);
			if (!APP_MODES.includes(input.mode)) throw new FamosError('bad_request', 'Unknown mode');
			checkRole(input.roleId);
			const actsFor = await checkActsFor(input.actsFor);
			const active = await t()
				.selectFrom('core_apps')
				.select((eb) => eb.fn.countAll<number>().as('n'))
				.where('revoked_at', 'is', null)
				.executeTakeFirstOrThrow();
			if (Number(active.n) >= MAX_APPS)
				throw new FamosError('limit_reached', 'Too many apps; revoke one first');
			const now = deps.clock.now();
			const id = deps.ids.next('app');
			await t()
				.insertInto('core_apps')
				.values({
					id,
					name,
					role_id: input.roleId,
					mode: input.mode,
					acts_for: JSON.stringify(actsFor),
					created_by: selfOf(actor),
					created_at: now,
					updated_at: now,
					revoked_at: null,
					paused_at: null,
				})
				.execute();
			return viewOf(id);
		},

		async update(actor, appId, input) {
			manager(actor);
			const row = await live(appId);
			const set: Partial<AppRow> = { updated_at: deps.clock.now() };
			if (input.name !== undefined) set.name = checkName(input.name);
			if (input.mode !== undefined) {
				if (!APP_MODES.includes(input.mode)) throw new FamosError('bad_request', 'Unknown mode');
				set.mode = input.mode;
			}
			if (input.roleId !== undefined) {
				checkRole(input.roleId);
				set.role_id = input.roleId;
			}
			if (input.actsFor !== undefined)
				set.acts_for = JSON.stringify(await checkActsFor(input.actsFor));
			await t().updateTable('core_apps').set(set).where('id', '=', row.id).execute();
			return viewOf(appId);
		},

		async pause(actor, appId) {
			manager(actor);
			await live(appId);
			const now = deps.clock.now();
			await t()
				.updateTable('core_apps')
				.set({ paused_at: now, updated_at: now })
				.where('id', '=', appId)
				.where('paused_at', 'is', null)
				.execute();
			return viewOf(appId);
		},

		async resume(actor, appId) {
			manager(actor);
			await live(appId);
			await t()
				.updateTable('core_apps')
				.set({ paused_at: null, updated_at: deps.clock.now() })
				.where('id', '=', appId)
				.execute();
			return viewOf(appId);
		},

		async revoke(actor, appId) {
			manager(actor);
			const row = await load(appId);
			if (row.revoked_at === null) {
				const now = deps.clock.now();
				await t()
					.updateTable('core_apps')
					.set({ revoked_at: now, updated_at: now })
					.where('id', '=', appId)
					.execute();
				await t()
					.updateTable('core_app_tokens')
					.set({ revoked_at: now })
					.where('app_id', '=', appId)
					.where('revoked_at', 'is', null)
					.execute();
			}
			return viewOf(appId);
		},

		async createToken(actor, appId, input) {
			manager(actor);
			await live(appId);
			const name = checkName(input.name);
			const days = checkDays(input.expiresInDays);
			const open = await t()
				.selectFrom('core_app_tokens')
				.select((eb) => eb.fn.countAll<number>().as('n'))
				.where('app_id', '=', appId)
				.where('revoked_at', 'is', null)
				.executeTakeFirstOrThrow();
			if (Number(open.n) >= MAX_TOKENS_PER_APP)
				throw new FamosError('limit_reached', 'Too many keys; revoke one first');
			return mint(appId, name, days);
		},

		async revokeToken(actor, appId, tokenId) {
			manager(actor);
			const row = await t()
				.selectFrom('core_app_tokens')
				.selectAll()
				.where('id', '=', tokenId)
				.where('app_id', '=', appId)
				.executeTakeFirst();
			if (!row) throw new FamosError('not_found', 'Key not found');
			if (row.revoked_at !== null) return tokenView(row);
			const now = deps.clock.now();
			await t()
				.updateTable('core_app_tokens')
				.set({ revoked_at: now })
				.where('id', '=', tokenId)
				.execute();
			return tokenView({ ...row, revoked_at: now });
		},

		async authenticate(secret, onBehalfOf) {
			if (!secret?.startsWith(API_TOKEN_PREFIX) || secret.length > 128) return null;
			const token = await t()
				.selectFrom('core_app_tokens')
				.selectAll()
				.where('token_hash', '=', await sha256Hex(secret))
				.where('revoked_at', 'is', null)
				.executeTakeFirst();
			if (!token) return null;
			if (token.expires_at !== null && token.expires_at <= deps.clock.now()) return null;
			const app = await t()
				.selectFrom('core_apps')
				.selectAll()
				.where('id', '=', token.app_id)
				.where('revoked_at', 'is', null)
				.where('paused_at', 'is', null)
				.executeTakeFirst();
			if (!app) return null;
			const caller = { id: app.id, name: app.name };
			if (onBehalfOf === undefined || onBehalfOf === null || onBehalfOf === '') {
				const actor: Actor = { kind: 'app', appId: app.id, roleId: app.role_id, mode: app.mode };
				return { actor, app: caller, tokenId: token.id, memberId: null, actsFor: actsForOf(app) };
			}
			// The member must be on the app's list and still active; anything else is refused, not
			// quietly served as the app itself, so a script never acts as nobody by mistake.
			const refuse = () =>
				new FamosError('forbidden', 'This app may not act for that member', {
					reason: 'on_behalf',
				});
			if (!actsForOf(app).includes(onBehalfOf)) throw refuse();
			const member = await t()
				.selectFrom('core_members')
				.select(['id', 'role_id'])
				.where('id', '=', onBehalfOf)
				.where('archived_at', 'is', null)
				.executeTakeFirst();
			if (!member) throw refuse();
			const actor: Actor = {
				kind: 'member',
				memberId: member.id as MemberId,
				roleId: member.role_id,
				via: { appId: app.id, appRoleId: app.role_id, mode: app.mode },
			};
			return {
				actor,
				app: caller,
				tokenId: token.id,
				memberId: member.id,
				actsFor: actsForOf(app),
			};
		},

		async isPaused(secret) {
			if (!secret?.startsWith(API_TOKEN_PREFIX) || secret.length > 128) return false;
			const token = await t()
				.selectFrom('core_app_tokens')
				.select(['app_id', 'expires_at'])
				.where('token_hash', '=', await sha256Hex(secret))
				.where('revoked_at', 'is', null)
				.executeTakeFirst();
			if (!token) return false;
			if (token.expires_at !== null && token.expires_at <= deps.clock.now()) return false;
			const app = await t()
				.selectFrom('core_apps')
				.select('id')
				.where('id', '=', token.app_id)
				.where('revoked_at', 'is', null)
				.where('paused_at', 'is not', null)
				.executeTakeFirst();
			return app !== undefined;
		},

		async touch(tokenId) {
			const now = deps.clock.now();
			await t()
				.updateTable('core_app_tokens')
				.set({ last_used_at: now })
				.where('id', '=', tokenId)
				.where((eb) =>
					eb.or([
						eb('last_used_at', 'is', null),
						eb('last_used_at', '<=', now - SEEN_RESOLUTION_MS),
					]),
				)
				.execute();
		},
	};
}
