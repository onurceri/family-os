import type {
	AiSettingsAdmin,
	BackupSettingsAdmin,
	DbExecutor,
	EmailSettingsAdmin,
	IdentityAdmin,
	JobContext,
	TelegramLinkAdmin,
} from '@famos/sdk';
import type { Access } from '../access.ts';
import type { ActionRunner } from '../action-runner.ts';
import type { AiAreas } from '../ai-areas.ts';
import type { ApiTokenService } from '../api-tokens.ts';
import type { AppService } from '../apps.ts';
import type { AuditTrail } from '../audit.ts';
import type { DeviceService } from '../devices.ts';
import type { createExtensionInstall } from '../extension-install.ts';
import type { Features } from '../features.ts';
import type { LanguagePort } from '../languages.ts';
import type { createNotifications } from '../notifications.ts';
import type { OAuthService } from '../oauth.ts';
import type { Registry } from '../registry.ts';
import type { Search } from '../search.ts';
import type { Themes } from '../themes.ts';

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
