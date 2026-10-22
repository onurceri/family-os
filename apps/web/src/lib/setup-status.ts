/**
 * The checks behind Settings → Setup status, as plain functions: what each one asks of the
 * family's setup, whether it is met, and where its button goes. The page only draws them.
 */

/** The facts the server reports (`core.getSetupStatus`). */
export interface SetupFacts {
	address: string | null;
	aiReading: boolean;
	backupTargets: number;
	pinMembers: number;
	familyDevices: number;
	phoneReach: number;
}

export interface SetupCheck {
	id: string;
	/** Translation keys, `ns:key` for an extension's. */
	titleKey: string;
	/** What the check is about, one line. */
	textKey: string;
	/** What stops working while it is missing, one line (an extension's step has none). */
	breaksKey?: string;
	actionKey: string;
	done: boolean;
	href: string;
	/** The button leaves the app (the published guide). */
	external?: boolean;
	/** What the person needs to open the page the button goes to; the button is left out without it. */
	requires?: string;
}

/** The guide that explains how to get an https address, where the project publishes its docs. */
export const HTTPS_GUIDE_URL =
	'https://github.com/onurceri/family-os/blob/main/docs/guide/https.md';

const isHttps = (address: string | null): boolean => address?.startsWith('https://') === true;

/**
 * The app's own checks. `secureContext` is whether this very page is one (browsers allow
 * installing, notifications and sharing only there); the address alone is not enough when the
 * family opens FamilyOS by another one, such as the server's IP address.
 */
export function coreChecks(facts: SetupFacts, secureContext: boolean): SetupCheck[] {
	const checks: SetupCheck[] = [
		{
			id: 'address',
			titleKey: 'app:setup_status_address',
			textKey: 'app:setup_status_address_text',
			breaksKey: 'app:setup_status_address_breaks',
			actionKey: 'app:setup_status_address_action',
			done: isHttps(facts.address) && secureContext,
			href: HTTPS_GUIDE_URL,
			external: true,
		},
		{
			id: 'ai',
			titleKey: 'app:setup_status_ai',
			textKey: 'app:setup_status_ai_text',
			breaksKey: 'app:setup_status_ai_breaks',
			actionKey: 'app:setup_status_ai_action',
			done: facts.aiReading,
			href: '/settings/ai',
			requires: 'core.ai.manage',
		},
		{
			id: 'backup',
			titleKey: 'app:setup_status_backup',
			textKey: 'app:setup_status_backup_text',
			breaksKey: 'app:setup_status_backup_breaks',
			actionKey: 'app:setup_status_backup_action',
			done: facts.backupTargets > 0,
			href: '/settings/backups',
			requires: 'core.settings.manage',
		},
	];
	if (facts.pinMembers > 0)
		checks.push({
			id: 'pin',
			titleKey: 'app:setup_status_pin',
			textKey: 'app:setup_status_pin_text',
			breaksKey: 'app:setup_status_pin_breaks',
			actionKey: 'app:setup_status_pin_action',
			done: facts.familyDevices > 0,
			href: '/settings/devices',
			requires: 'core.devices.manage',
		});
	if (isHttps(facts.address))
		checks.push({
			id: 'phones',
			titleKey: 'app:setup_status_phones',
			textKey: 'app:setup_status_phones_text',
			breaksKey: 'app:setup_status_phones_breaks',
			actionKey: 'app:setup_status_phones_action',
			done: facts.phoneReach > 0,
			href: '/settings/notifications',
		});
	return checks;
}

/** What an extension's setup hint gives a check (the same step Today's first steps show). */
export interface HintLike {
	id: string;
	titleKey: string;
	textKey: string;
	actionKey: string;
	href: string;
	requires: string;
}

/** The checks of the extensions' steps, in the order given, each once its answer is in. */
export function hintChecks(
	hints: readonly HintLike[],
	done: Readonly<Record<string, boolean | undefined>>,
): SetupCheck[] {
	return hints.flatMap((h) => {
		const answer = done[h.id];
		if (answer === undefined) return [];
		return [
			{
				id: h.id,
				titleKey: h.titleKey,
				textKey: h.textKey,
				actionKey: h.actionKey,
				done: answer,
				href: h.href,
				requires: h.requires,
			},
		];
	});
}

/** The checks that still need someone, then the ones that are done; each keeps its order. */
export function splitChecks(checks: readonly SetupCheck[]): {
	missing: SetupCheck[];
	done: SetupCheck[];
} {
	return { missing: checks.filter((c) => !c.done), done: checks.filter((c) => c.done) };
}
