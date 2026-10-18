import type { paths } from '@famos/api-client';
import { accessBook } from './access.svelte';
import { api } from './api';

export type Member =
	paths['/api/v1/core/me']['get']['responses'][200]['content']['application/json'];

async function loadMe() {
	const res = await api.GET('/api/v1/core/me');
	return res.data ?? null;
}

/**
 * App-wide session state. `status` drives routing in the root layout:
 * setup → first-run wizard, anonymous → sign-in, ready → the app.
 */
class Session {
	status = $state<'loading' | 'setup' | 'anonymous' | 'ready' | 'offline'>('loading');
	me = $state<Member | null>(null);
	appVersion = $state('');
	/** First-run setup asks for the one-time code from the server log. */
	setupNeedsCode = $state(false);

	/** Whether the signed-in member's role grants a capability. The API decides; this only shapes the UI. */
	can(capability: string): boolean {
		return this.me?.capabilities.includes(capability) ?? false;
	}

	/** Extensions turned off in More → Features; their UI is hidden. */
	get disabledExtensions(): readonly string[] {
		return this.me?.disabledExtensions ?? [];
	}

	async refresh(): Promise<void> {
		try {
			const setup = await api.GET('/api/v1/core/setup');
			if (!setup.data) throw new Error('setup status unavailable');
			this.appVersion = setup.data.appVersion;
			this.setupNeedsCode = setup.data.needsCode;
			if (setup.data.needsSetup) {
				this.me = null;
				this.status = 'setup';
				return;
			}
			// What the member may do is known before the app shows, so no control flashes in and out.
			const [me] = await Promise.all([loadMe(), accessBook.load()]);
			this.me = me;
			if (!me) accessBook.clear();
			this.status = me ? 'ready' : 'anonymous';
		} catch {
			this.status = 'offline';
		}
	}
}

export const session = new Session();
