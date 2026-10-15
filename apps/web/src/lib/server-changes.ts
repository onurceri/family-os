import { api } from './api.js';
import { loadedFingerprint } from './extensions.js';
import { onReconnect } from './realtime.js';
import { extensionsChanged } from './restart.js';

/**
 * Calls `changed` once when the server runs other extensions than this page loaded. A server that
 * restarted closes the live connection, so the check runs whenever it reconnects.
 */
export function onExtensionsChanged(changed: () => void): () => void {
	let told = false;
	return onReconnect(() => {
		if (told) return;
		void api.GET('/api/v1/core/extensions/loaded').then(
			({ data }) => {
				if (told || !extensionsChanged(loadedFingerprint(), data?.fingerprint)) return;
				told = true;
				changed();
			},
			() => {},
		);
	});
}
