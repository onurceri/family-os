import { conversationAnswered, defineEvent } from '@famos/sdk';
import { z } from 'zod';

/** Everything the event carries; ids and kinds only, no content: who proposed what, whence. */
const draftCreatedPayload = z.object({
	draftId: z.string(),
	actionId: z.string(),
	/** Who proposed it. `member`: a person; `ai`: the Inbox or the assistant; `system`: a job. */
	proposerKind: z.enum(['member', 'ai', 'system', 'display']),
	/** The member behind it: the person, or the one the assistant works for or the Inbox item is from. */
	proposerMemberId: z.string().nullable(),
	/** Where it came from: `inbox`, `assistant`… (null for a hand-made proposal). */
	sourceKind: z.string().nullable(),
});
export const draftCreated = defineEvent('core.draft.created', draftCreatedPayload);
export const draftUpdated = defineEvent(
	'core.draft.updated',
	z.object({ draftId: z.string(), status: z.string() }),
);
export const memberChanged = defineEvent(
	'core.member.changed',
	// `endSessions`: the member must sign in again (archived).
	z.object({ memberId: z.string(), endSessions: z.boolean().optional() }),
);
export const roleChanged = defineEvent('core.role.changed', z.object({ roleId: z.string() }));

export const featuresChanged = defineEvent(
	'core.features.changed',
	z.object({ extensionId: z.string(), enabled: z.boolean() }),
);

export const aiAreasChanged = defineEvent(
	'core.aiAreas.changed',
	z.object({ extensionId: z.string(), access: z.enum(['off', 'local', 'any']) }),
);

export const deviceChanged = defineEvent('core.device.changed', z.object({ deviceId: z.string() }));
/** A display told what its screen had no room for (Settings → Devices shows it). */
export const displayFitChanged = defineEvent(
	'core.displayFit.changed',
	z.object({ deviceId: z.string() }),
);

/** A notification was created for a member (ids only): open tabs refresh their list and badge. */
export const notificationCreated = defineEvent(
	'core.notification.created',
	z.object({ memberId: z.string() }),
);
export const notificationRead = defineEvent(
	'core.notification.read',
	z.object({ memberId: z.string() }),
);

export const coreEvents = [
	draftCreated,
	conversationAnswered,
	draftUpdated,
	memberChanged,
	roleChanged,
	deviceChanged,
	displayFitChanged,
	featuresChanged,
	aiAreasChanged,
	notificationCreated,
	notificationRead,
];
