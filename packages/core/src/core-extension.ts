import { DAY_MS, defineExtension, SDK_VERSION } from '@famos/sdk';
import { createAdminActions } from './admin-actions.ts';
import { createAiSettingsActions } from './ai-settings-actions.ts';
import { createAutoApproval } from './auto-approval.ts';
import { pruneChanges, schedulePruneChanges } from './changes.ts';
import { createChannelActions } from './channel-actions.ts';
import { CORE_CAPABILITIES } from './core-capabilities.ts';
import { coreEvents } from './core-events.ts';
import type { CoreExtensionDeps } from './core-extension/deps.ts';
import { createDrafts } from './core-extension/drafts.ts';
import { createMembers } from './core-extension/members.ts';
import {
	backupFailed,
	backupRestored,
	draftDecided,
	draftWaiting,
} from './core-extension/notification-kinds.ts';
import { createRoles } from './core-extension/roles.ts';
import { createSettings } from './core-extension/settings.ts';
import { createSetup } from './core-extension/setup.ts';
import { createSignIn } from './core-extension/sign-in.ts';
import { createSuggestions } from './core-extension/suggestions.ts';
import { today } from './core-extension/today.ts';
import { scheduleExpiry } from './draft-expiry.ts';
import { pruneIdempotency, schedulePrune } from './idempotency.ts';
import { createLanguages } from './languages.ts';
import { createMemory } from './memory.ts';
import { coreMigrations } from './migrations/0001_init.ts';
import { setMyNextUp } from './next-up.ts';
import { oauthCleanup, oauthNotifications, scheduleOAuthCleanup } from './oauth.ts';
import { createRetention, schedulePruneHistory } from './retention.ts';

export type { CoreExtensionDeps } from './core-extension/deps.ts';
export { DraftSchema } from './core-extension/drafts.ts';
export {
	END_CREDENTIALS_JOB,
	MEMBER_COLORS,
	type Member,
	MemberSchema,
	SignInMethodsSchema,
} from './core-extension/member-rows.ts';
export {
	backupFailed,
	backupRestored,
	draftDecided,
	draftWaiting,
} from './core-extension/notification-kinds.ts';
export { CapabilityViewSchema, RoleViewSchema } from './core-extension/roles.ts';

export function createCoreExtension(deps: CoreExtensionDeps) {
	const autoApproval = createAutoApproval({
		runner: deps.runner,
		access: deps.access,
		registry: deps.registry,
		draftNotifyDelayMs: deps.draftNotifyDelayMs,
	});

	const languages = createLanguages({ languages: deps.languages });
	const memory = createMemory();
	const admin = createAdminActions({
		apps: deps.apps,
		apiTokens: deps.apiTokens,
		oauth: deps.oauth,
		devices: deps.devices,
		identity: deps.identity,
	});
	const people = createMembers(deps, languages);
	const roles = createRoles(deps);
	const settings = createSettings(deps, languages);
	const setup = createSetup(deps, languages);
	const signIn = createSignIn(deps);
	const drafts = createDrafts(deps);
	const suggestions = createSuggestions(deps);

	const retention = createRetention({
		keepApplied: (draft) =>
			!deps.registry().actions.has(draft.action_id) || deps.runner().undoStep(draft) !== null,
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
			drafts.decidableSources,
			drafts.editDraft,
			suggestions.mySuggestions,
			suggestions.suggestionsDigest,
			today,
			people.createMember,
			people.updateMember,
			people.setMyLanguage,
			setMyNextUp,
			people.archiveMember,
			settings.setFeatureEnabled,
			settings.setAiAreaAccess,
			settings.updateFamilySettings,
			settings.setFamilyName,
			...languages.actions,
			...deps.themes.actions,
			roles.createRole,
			roles.updateRole,
			roles.deleteRole,
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
			retention.job,
			drafts.expireDrafts,
			signIn.endCredentials,
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
			roles.listRoles,
			setup.setupStatus,
			setup.setup,
			signIn.me,
			signIn.myAccess,
			settings.listFeatures,
			settings.listAiAreas,
			people.listMembers,
			people.listProfiles,
			settings.familyName,
			settings.familySettings,
			signIn.listDevices,
			signIn.currentDevice,
			signIn.setPin,
			signIn.setPassword,
			signIn.signOutEverywhere,
			drafts.listDrafts,
			drafts.countWaiting,
			drafts.approve,
			drafts.reject,
			drafts.undo,
			drafts.suggestAgain,
			drafts.replace,
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
			await schedulePruneHistory(ctx, ctx.clock.now() + DAY_MS);
			// Suggestions about a day that has passed expire shortly after midnight (family time).
			await scheduleExpiry(ctx);
		},
	});
}
