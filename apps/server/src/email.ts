import type { Email } from '@famos/adapters/email';
import { type Kernel, memberChanged } from '@famos/core';

/**
 * Connects the email adapter to the kernel. Mail from an allowed sender goes to the kernel's
 * share target as the member the address belongs to, so capabilities, quotas, feature switches
 * and photo metadata stripping apply as for an upload in the app.
 */
export function wireEmail(email: Email, kernel: Kernel): void {
	email.setHandlers({
		async onShare({ memberId, title, text, files }) {
			await kernel.share(memberId, {
				channel: 'email',
				...(title !== undefined && { title }),
				...(text !== undefined && { text }),
				files,
			});
		},
	});

	// A member who left cannot receive mail any more: their addresses are removed.
	kernel.bus.on(memberChanged, async ({ memberId, endSessions }) => {
		if (endSessions) await email.removeSendersOf(memberId);
	});
}
