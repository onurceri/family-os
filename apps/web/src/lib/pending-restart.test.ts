import { describe, expect, it } from 'vitest';
import type { ExtensionList } from '../routes/settings/extensions/entries.js';
import { showsRestartLine, waitingCount } from './pending-restart.js';

const entry = (over: Record<string, unknown>) => ({ id: 'x', status: 'installed', ...over });
const list = (...entries: Record<string, unknown>[]) =>
	({ restartNeeded: true, extensions: entries.map(entry) }) as unknown as ExtensionList;

describe('waitingCount', () => {
	it('counts installs, uninstalls and updates that wait', () => {
		expect(
			waitingCount(
				list(
					{ status: 'pending_install' },
					{ status: 'pending_uninstall' },
					{ nextVersion: '2.0.0' },
				),
			),
		).toBe(3);
	});
	it('is zero when nothing waits', () => {
		expect(waitingCount(list({}, { nextVersion: null }))).toBe(0);
		expect(waitingCount(list())).toBe(0);
	});
});

describe('showsRestartLine', () => {
	const base = { can: true, needed: true, path: '/', today: '/', settingsMode: false };
	it('shows on Today', () => expect(showsRestartLine(base)).toBe(true));
	it('shows in settings mode', () =>
		expect(showsRestartLine({ ...base, path: '/settings/family', settingsMode: true })).toBe(true));
	it('hides without the capability', () =>
		expect(showsRestartLine({ ...base, can: false })).toBe(false));
	it('hides when no restart is needed', () =>
		expect(showsRestartLine({ ...base, needed: false })).toBe(false));
	it('hides on other pages', () =>
		expect(showsRestartLine({ ...base, path: '/lists' })).toBe(false));
	it('hides on the extensions page itself', () =>
		expect(showsRestartLine({ ...base, path: '/settings/extensions', settingsMode: true })).toBe(
			false,
		));
});
