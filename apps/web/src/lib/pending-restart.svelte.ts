import { api } from './api';
import { waitingCount } from './pending-restart.js';
import { session } from './session.svelte.js';

/**
 * Whether changes to extensions wait for a restart, and how many, for people who may restart
 * FamilyOS. Read again at sign-in, after every change to extensions and after a reconnect (which is
 * how the line goes away once the server restarted).
 */
class PendingRestart {
	needed = $state(false);
	count = $state(0);

	async refresh(): Promise<void> {
		if (!session.can('core.extensions.manage')) {
			this.needed = false;
			this.count = 0;
			return;
		}
		try {
			const res = await api.GET('/api/v1/core/extensions');
			if (!res.data) return;
			this.needed = res.data.restartNeeded;
			this.count = waitingCount(res.data);
		} catch {
			// Keep what is known; the next change or reconnect reads again.
		}
	}
}

export const pendingRestart = new PendingRestart();
