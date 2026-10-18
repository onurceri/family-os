import type { PresenterMember } from '@famos/ui/slots';
import { api } from './api';
import { family } from './family.svelte.js';
import { onEvent } from './realtime.js';
import { roleManagersOf } from './role-managers.js';
import { session } from './session.svelte.js';

/**
 * Who may change what roles allow, read the first time a page asks (a tap on "View only") and
 * again after a role or a member changed.
 */
class RoleManagers {
	private roles = $state<readonly { id: string; capabilities: readonly string[] }[] | null>(null);
	private reading = false;
	private watching = false;

	list(): readonly PresenterMember[] | undefined {
		if (this.roles === null) {
			// Read outside the reactive read that asked, which may not change state itself.
			queueMicrotask(() => void this.read());
			return undefined;
		}
		return roleManagersOf(this.roles, family.members);
	}

	private async read(): Promise<void> {
		if (this.reading || this.roles !== null || !session.can('core.members.view')) return;
		this.reading = true;
		try {
			const res = await api.GET('/api/v1/core/roles');
			if (res.data) this.roles = res.data.roles;
		} catch {
			// Unknown: the line names no one and says whom to ask in general.
		} finally {
			this.reading = false;
		}
		if (!this.watching) {
			this.watching = true;
			const forget = () => {
				this.roles = null;
			};
			onEvent('core.role.', forget);
			onEvent('core.member.', forget);
		}
	}
}

export const roleManagers = new RoleManagers();
