import { FamosError, personPresent } from '@famos/sdk';
import { CORE_CAPABILITIES } from '../core-capabilities.ts';
import { inspectAddress } from './addresses.ts';
import type { OAuthBase } from './base.ts';
import { SETTINGS_KEY } from './constants.ts';
import { OAuthError } from './errors.ts';
import type { OAuthDeps, OAuthService, OAuthSettings, OAuthStatus } from './types.ts';

/** The family's switches for AI app sign-in, and whether sign-in can work at the family address. */
export function createOAuthSettings(deps: OAuthDeps, { t }: OAuthBase) {
	const readSettings = async (): Promise<OAuthSettings> => {
		const row = await t()
			.selectFrom('core_settings')
			.select('value')
			.where('key', '=', SETTINGS_KEY)
			.executeTakeFirst();
		const off = { oauthEnabled: false, dcrEnabled: false, allowPlainHttp: false };
		if (!row) return off;
		try {
			const v = JSON.parse(row.value) as Partial<Record<keyof OAuthSettings, unknown>>;
			return {
				oauthEnabled: v.oauthEnabled === true,
				dcrEnabled: v.dcrEnabled === true,
				allowPlainHttp: v.allowPlainHttp === true,
			};
		} catch {
			return off;
		}
	};

	const statusOf = async (): Promise<OAuthStatus> => {
		const settings = await readSettings();
		const address = inspectAddress(deps.publicUrl, settings.allowPlainHttp);
		const issuer = address.origin;
		return {
			...settings,
			active: settings.oauthEnabled && issuer !== null && (await deps.mcpEnabled()),
			issuer,
			resource: issuer ? `${issuer}/mcp` : null,
			addressProblem: address.problem,
		};
	};

	const requireActive = async (): Promise<OAuthStatus & { resource: string; issuer: string }> => {
		const status = await statusOf();
		if (!status.active || !status.resource || !status.issuer)
			throw new OAuthError('temporarily_unavailable', 'Signing in AI apps is not turned on');
		return { ...status, resource: status.resource, issuer: status.issuer };
	};

	const methods: Pick<OAuthService, 'settings' | 'status' | 'setSettings'> = {
		settings: readSettings,
		status: statusOf,

		async setSettings(actor, patch) {
			if (!personPresent(actor)) throw new FamosError('forbidden', 'Only members can do this');
			if (!deps.access().can(actor, CORE_CAPABILITIES.aiManage.id))
				throw new FamosError('forbidden', 'Not allowed to manage AI settings');
			const now = deps.clock.now();
			const current = await readSettings();
			const next: OAuthSettings = {
				oauthEnabled: patch.oauthEnabled ?? current.oauthEnabled,
				dcrEnabled: patch.dcrEnabled ?? current.dcrEnabled,
				allowPlainHttp: patch.allowPlainHttp ?? current.allowPlainHttp,
			};
			if (!next.oauthEnabled && patch.dcrEnabled === true)
				throw new FamosError('bad_request', 'Turn on signing in AI apps first');
			// Registration only means something while sign-in is on.
			if (!next.oauthEnabled) next.dcrEnabled = false;
			if (next.oauthEnabled) {
				const address = inspectAddress(deps.publicUrl, next.allowPlainHttp);
				if (address.problem === 'no_address')
					throw new FamosError('bad_request', 'Set the family address (FAMOS_BASE_URL) first');
				if (address.problem === 'has_path')
					throw new FamosError(
						'bad_request',
						'AI apps can sign in only when the family address has no path after the host',
					);
				if (address.problem === 'plain_http')
					throw new FamosError(
						'bad_request',
						'AI apps can sign in on an http address only when you allow it for the home network',
					);
			}
			const value = JSON.stringify(next);
			await t()
				.insertInto('core_settings')
				.values({ key: SETTINGS_KEY, value, updated_at: now })
				.onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: now }))
				.execute();
			return next;
		},
	};
	return { readSettings, statusOf, requireActive, methods };
}

export type OAuthSettingsPart = ReturnType<typeof createOAuthSettings>;
