import {
	type Actor,
	APP_MODES,
	assertFullSignIn,
	defineAction,
	defineJob,
	FamosError,
	type IdentityAdmin,
	idSchema,
	personPresent,
} from '@famos/sdk';
import { z } from 'zod';
import type { ApiTokenService, ApiTokenView } from './api-tokens.ts';
import type { AppService, AppTokenView, AppView } from './apps.ts';
import { CORE_CAPABILITIES } from './core-capabilities.ts';
import { deviceChanged } from './core-events.ts';
import { DeviceSchema, type DeviceService, toDevice } from './devices.ts';
import type { OAuthService } from './oauth.ts';

/**
 * What an admin changes about connected apps, AI-app keys, displays and devices. Minting a key
 * (its secret is shown once) and trusting a device (it sets a cookie) stay routes; the record
 * of an app, every revocation, the MCP switch and what a display may show are actions, so the
 * runner decides who may do them and the audit log names what they touched. Every one is a
 * person's own act: the capabilities they need are critical (the AI never runs nor proposes
 * them, no app ever holds them) or, for a member's own key, never held by an app; none returns
 * a secret, since the runner keeps an action's answer for replays.
 */

export const AppTokenSchema = z.object({
	id: z.string(),
	name: z.string(),
	expiresAt: z.number().int().nullable(),
	lastUsedAt: z.number().int().nullable(),
	createdAt: z.number().int(),
	revokedAt: z.number().int().nullable(),
});

export const AppSchema = z.object({
	id: z.string(),
	name: z.string(),
	roleId: z.string(),
	mode: z.enum(APP_MODES),
	/** Member ids the app may act for. */
	actsFor: z.array(z.string()),
	createdAt: z.number().int(),
	revokedAt: z.number().int().nullable(),
	/** Set while the app is paused (by an admin, or after a restore). */
	pausedAt: z.number().int().nullable(),
	lastUsedAt: z.number().int().nullable(),
	tokens: z.array(AppTokenSchema),
});

export const presentAppToken = (token: AppTokenView): z.infer<typeof AppTokenSchema> => ({
	id: token.id,
	name: token.name,
	expiresAt: token.expiresAt,
	lastUsedAt: token.lastUsedAt,
	createdAt: token.createdAt,
	revokedAt: token.revokedAt,
});

export const presentApp = (app: AppView): z.infer<typeof AppSchema> => ({
	id: app.id,
	name: app.name,
	roleId: app.roleId,
	mode: app.mode,
	actsFor: app.actsFor,
	createdAt: app.createdAt,
	revokedAt: app.revokedAt,
	pausedAt: app.pausedAt,
	lastUsedAt: app.lastUsedAt,
	tokens: app.tokens.map(presentAppToken),
});

export const ApiTokenSchema = z.object({
	id: z.string(),
	name: z.string(),
	scope: z.enum(['read', 'read_write']),
	expiresAt: z.number().int().nullable(),
	lastUsedAt: z.number().int().nullable(),
	createdAt: z.number().int(),
	revokedAt: z.number().int().nullable(),
	/** An AI app that signed in with a family account, not a key the member made. */
	signedIn: z.boolean(),
	/** Whose token it is (the list of everyone's only; null for the caller's own). */
	member: z.string().nullable(),
});

export const presentApiToken = (
	token: ApiTokenView,
	names: ReadonlyMap<string, string> | null,
): z.infer<typeof ApiTokenSchema> => ({
	id: token.id,
	name: token.name,
	scope: token.scope,
	expiresAt: token.expiresAt,
	lastUsedAt: token.lastUsedAt,
	createdAt: token.createdAt,
	revokedAt: token.revokedAt,
	signedIn: token.oauthClientId !== null,
	member: names ? (names.get(token.memberId) ?? null) : null,
});

/** What a display may show, as an admin gives it at pairing and changes it later. */
export const DisplayGrantSchema = z.object({
	name: z.string().trim().min(1).max(60),
	capabilities: z.array(z.string().max(80)).max(50),
	showNames: z.boolean(),
});

const AppName = z.string().trim().min(1).max(60);
const RoleId = z.string().min(1).max(80);
const ActsFor = z.array(z.string().max(80)).max(50);
const AppId = idSchema('app');
const AppIdInput = z.object({ appId: AppId });

/** Ends the sessions signed in on a revoked device; the identity store is outside a transaction. */
export const END_DEVICE_SESSIONS_JOB = 'core.endDeviceSessions';

export function createAdminActions(deps: {
	apps: () => AppService;
	apiTokens: () => ApiTokenService;
	oauth: () => OAuthService;
	devices: () => DeviceService;
	identity: Pick<IdentityAdmin, 'endDeviceSessions'>;
}) {
	/** A person acting directly: an app, the AI and the system never manage these. */
	const person = (actor: Actor): Actor => {
		if (!personPresent(actor)) throw new FamosError('forbidden', 'Only members can do this');
		return actor;
	};
	const appTarget = (input: { appId: string }) => ({ table: 'core_apps', id: input.appId });

	const createApp = defineAction({
		id: 'core.createApp',
		title: 'Connect an app (Home Assistant, a script) with a role and a mode',
		input: z.object({
			name: AppName,
			roleId: RoleId,
			mode: z.enum(APP_MODES),
			actsFor: ActsFor.default([]),
		}),
		output: AppSchema,
		requires: CORE_CAPABILITIES.appsManage.id,
		approval: 'never',
		async run(uow, input) {
			// An app is a credential holder: a PIN sign-in never registers one.
			assertFullSignIn(uow.actor);
			return presentApp(await deps.apps().in(uow.db).create(uow.actor, input));
		},
	});

	const updateApp = defineAction({
		id: 'core.updateApp',
		title: 'Change an app’s name, role, mode or the members it may act for',
		input: z.object({
			appId: AppId,
			name: AppName.optional(),
			roleId: RoleId.optional(),
			mode: z.enum(APP_MODES).optional(),
			actsFor: ActsFor.optional(),
		}),
		output: AppSchema,
		requires: CORE_CAPABILITIES.appsManage.id,
		approval: 'never',
		target: appTarget,
		async run(uow, { appId, ...patch }) {
			assertFullSignIn(uow.actor);
			return presentApp(await deps.apps().in(uow.db).update(uow.actor, appId, patch));
		},
	});

	const pauseApp = defineAction({
		id: 'core.pauseApp',
		title: 'Pause an app: its keys stop working until it is resumed',
		input: AppIdInput,
		output: AppSchema,
		requires: CORE_CAPABILITIES.appsManage.id,
		approval: 'never',
		target: appTarget,
		async run(uow, { appId }) {
			assertFullSignIn(uow.actor);
			return presentApp(await deps.apps().in(uow.db).pause(uow.actor, appId));
		},
	});

	const resumeApp = defineAction({
		id: 'core.resumeApp',
		title: 'Let a paused app work again',
		input: AppIdInput,
		output: AppSchema,
		requires: CORE_CAPABILITIES.appsManage.id,
		approval: 'never',
		target: appTarget,
		async run(uow, { appId }) {
			assertFullSignIn(uow.actor);
			return presentApp(await deps.apps().in(uow.db).resume(uow.actor, appId));
		},
	});

	const revokeApp = defineAction({
		id: 'core.revokeApp',
		title: 'Revoke an app and all its keys at once',
		input: AppIdInput,
		output: AppSchema,
		requires: CORE_CAPABILITIES.appsManage.id,
		approval: 'never',
		target: appTarget,
		async run(uow, { appId }) {
			assertFullSignIn(uow.actor);
			return presentApp(await deps.apps().in(uow.db).revoke(uow.actor, appId));
		},
	});

	const revokeAppToken = defineAction({
		id: 'core.revokeAppToken',
		title: 'Revoke one key of an app at once',
		input: z.object({ appId: AppId, tokenId: idSchema('app_token') }),
		output: AppTokenSchema,
		requires: CORE_CAPABILITIES.appsManage.id,
		approval: 'never',
		target: (input) => ({ table: 'core_app_tokens', id: input.tokenId }),
		async run(uow, { appId, tokenId }) {
			assertFullSignIn(uow.actor);
			return presentAppToken(await deps.apps().in(uow.db).revokeToken(uow.actor, appId, tokenId));
		},
	});

	const revokeApiToken = defineAction({
		id: 'core.revokeApiToken',
		title: 'Revoke a key of an AI app at once (your own, or anyone’s with permission to manage AI)',
		input: z.object({ tokenId: idSchema('api_token') }),
		output: ApiTokenSchema,
		// The keys belong to the people who may make them; an app never holds this capability.
		requires: CORE_CAPABILITIES.mcpUse.id,
		approval: 'never',
		target: (input) => ({ table: 'core_api_tokens', id: input.tokenId }),
		async run(uow, { tokenId }) {
			const actor = person(uow.actor);
			return presentApiToken(await deps.apiTokens().in(uow.db).revoke(actor, tokenId), null);
		},
	});

	const setMcpEnabled = defineAction({
		id: 'core.setMcpEnabled',
		title: 'Turn the door for AI apps (MCP) on or off',
		input: z.object({ enabled: z.boolean() }),
		output: z.object({ enabled: z.boolean() }),
		requires: CORE_CAPABILITIES.aiManage.id,
		approval: 'never',
		async run(uow, { enabled }) {
			await deps.apiTokens().in(uow.db).setEnabled(person(uow.actor), enabled);
			return { enabled };
		},
	});

	const OAuthSettingsSchema = z.object({
		oauthEnabled: z.boolean(),
		dcrEnabled: z.boolean(),
		allowPlainHttp: z.boolean(),
	});

	const setMcpOAuth = defineAction({
		id: 'core.setMcpOAuth',
		title:
			'Choose whether AI apps may sign in with a family account, register themselves, or use plain http',
		input: OAuthSettingsSchema.partial(),
		output: OAuthSettingsSchema,
		requires: CORE_CAPABILITIES.aiManage.id,
		approval: 'never',
		async run(uow, patch) {
			return deps.oauth().in(uow.db).setSettings(person(uow.actor), patch);
		},
	});

	const deleteOAuthClient = defineAction({
		id: 'core.deleteOAuthClient',
		title: 'Remove an app set up to sign in, and end every sign-in it holds',
		input: z.object({ clientId: idSchema('oauth_client') }),
		output: z.object({ id: z.string(), name: z.string() }),
		// Like the keys: the member who set it up, or whoever manages AI; never an app.
		requires: CORE_CAPABILITIES.mcpUse.id,
		approval: 'never',
		target: (input) => ({ table: 'core_oauth_clients', id: input.clientId }),
		async run(uow, { clientId }) {
			const removed = await deps.oauth().in(uow.db).deleteClient(person(uow.actor), clientId);
			return { id: removed.id, name: removed.name };
		},
	});

	const confirmDisplayPairing = defineAction({
		id: 'core.confirmDisplayPairing',
		title: 'Confirm the code a display shows, name it and choose what it may show',
		input: DisplayGrantSchema.extend({ userCode: z.string().max(20) }),
		output: z.object({ name: z.string(), pairingId: z.string() }),
		requires: CORE_CAPABILITIES.devicesManage.id,
		approval: 'never',
		// The code is looked up first, on its own: a wrong one is counted against every open
		// pairing, and a refusal inside the transaction would take the count back with it.
		prepare: ({ userCode, ...grant }, actor) =>
			deps.devices().findPairing(person(actor), userCode, grant),
		async run(uow, { userCode, ...grant }, prepared) {
			const actor = person(uow.actor);
			const pairingId =
				typeof prepared === 'string'
					? prepared
					: await deps.devices().findPairing(actor, userCode, grant);
			return deps.devices().confirmPairingIn(uow.db, actor, pairingId, grant);
		},
	});

	const updateDisplay = defineAction({
		id: 'core.updateDisplay',
		title: 'Rename a display or change what it may show',
		input: DisplayGrantSchema.partial().extend({ deviceId: idSchema('device') }),
		output: DeviceSchema,
		requires: CORE_CAPABILITIES.devicesManage.id,
		approval: 'never',
		target: (input) => ({ table: 'core_devices', id: input.deviceId }),
		async run(uow, { deviceId, ...patch }) {
			const row = await deps.devices().updateDisplayIn(uow.db, person(uow.actor), deviceId, patch);
			// Its open screens ask again what they may show.
			uow.emit(deviceChanged, { deviceId });
			return toDevice(row, deps.devices().leftOut(deviceId));
		},
	});

	const revokeDevice = defineAction({
		id: 'core.revokeDevice',
		title: 'Revoke a trusted device or a display (stops profile picker and PIN sign-in on it)',
		input: z.object({ deviceId: idSchema('device') }),
		output: DeviceSchema,
		requires: CORE_CAPABILITIES.devicesManage.id,
		approval: 'never',
		target: (input) => ({ table: 'core_devices', id: input.deviceId }),
		async run(uow, { deviceId }) {
			const row = await deps.devices().revokeIn(uow.db, person(uow.actor), deviceId);
			// The device stops counting at once (a revoked device is never verified, and every
			// PIN session asks whether its device is still active); its sessions end in the job.
			await uow.enqueue(END_DEVICE_SESSIONS_JOB, { deviceId });
			uow.emit(deviceChanged, { deviceId });
			return toDevice(row);
		},
	});

	const endDeviceSessions = defineJob({
		name: END_DEVICE_SESSIONS_JOB,
		payload: z.object({ deviceId: z.string() }),
		maxAttempts: 10,
		timeoutMs: 30_000,
		backoff: (attempt) => Math.min(60_000, 2_000 * 2 ** (attempt - 1)),
		async handle(_ctx, { deviceId }) {
			await deps.identity.endDeviceSessions(deviceId);
		},
	});

	return {
		actions: [
			createApp,
			updateApp,
			pauseApp,
			resumeApp,
			revokeApp,
			revokeAppToken,
			revokeApiToken,
			setMcpEnabled,
			setMcpOAuth,
			deleteOAuthClient,
			confirmDisplayPairing,
			updateDisplay,
			revokeDevice,
		],
		jobs: [endDeviceSessions],
	};
}
