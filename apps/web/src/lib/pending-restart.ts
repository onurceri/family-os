import { type ExtensionList, pendingOf } from '../routes/settings/extensions/entries.js';

/** How many extensions wait for a restart to install, uninstall or update. */
export function waitingCount(list: ExtensionList): number {
	return list.extensions.filter((entry) => pendingOf(entry) !== null).length;
}

/**
 * Whether the shell shows the "restart waiting" line: only to people who may restart, on Today and
 * in settings mode, and never on the page that already owns the restart.
 */
export function showsRestartLine(input: {
	can: boolean;
	needed: boolean;
	path: string;
	today: string;
	settingsMode: boolean;
}): boolean {
	if (!input.can || !input.needed) return false;
	if (input.path === '/settings/extensions') return false;
	return input.path === input.today || input.settingsMode;
}
