import {
	ANY_MEMBER,
	type AudienceTarget,
	conversationAnswered,
	defineEvent,
	EVERYONE,
} from '@famos/sdk';
import { z } from 'zod';
import { CORE_CAPABILITIES } from './core-capabilities.ts';

/** Everything the event carries; ids and kinds only, no content: who proposed what, whence. */
const draftCreatedPayload = z.object({
	draftId: z.string(),
	actionId: z.string(),
	/** Who proposed it. `member`: a person; `ai`: the Inbox or the assistant; `system`: a job. */
	proposerKind: z.enum(['member', 'app', 'ai', 'system', 'display']),
	/** The member behind it: the person, or the one the assistant works for or the Inbox item is from. */
	proposerMemberId: z.string().nullable(),
	/** Where it came from: `inbox`, `assistant`… (null for a hand-made proposal). */
	sourceKind: z.string().nullable(),
	/** Set when the draft is addressed to one member (a memory question): it is theirs alone. */
	forMember: z.string().nullable().optional(),
});

/**
 * Who hears of a draft: those who list drafts and the displays that show how many wait, and for a
 * draft addressed to one member, that member only.
 */
const draftAudience = (payload: { forMember?: string | null }): AudienceTarget[] =>
	payload.forMember
		? [{ member: payload.forMember }]
		: [CORE_CAPABILITIES.draftsPropose.id, CORE_CAPABILITIES.draftsWaiting.id];

/** A draft is a thing in the change log, so a list of waiting suggestions has a validator. */
const draftChanges = ({ draftId }: { draftId: string }) => [
	{ entity: 'draft', id: draftId, op: 'upsert' as const },
];

export const draftCreated = defineEvent('core.draft.created', draftCreatedPayload, {
	audience: draftAudience,
	changes: draftChanges,
});
export const draftUpdated = defineEvent(
	'core.draft.updated',
	z.object({
		draftId: z.string(),
		status: z.string(),
		forMember: z.string().nullable().optional(),
	}),
	{ audience: draftAudience, changes: draftChanges },
);
/**
 * Someone's profile, role or standing changed. The member hears of their own, and those who see
 * the family's people hear of all (names and roles are what a list shows).
 */
export const memberChanged = defineEvent(
	'core.member.changed',
	// `endSessions`: the member must sign in again (archived).
	z.object({ memberId: z.string(), endSessions: z.boolean().optional() }),
	{ audience: (payload) => [{ member: payload.memberId }, CORE_CAPABILITIES.membersView.id] },
);
/** A member's sign-in ended (sign-out, a new password, archiving): their open sockets close. */
export const sessionEnded = defineEvent(
	'core.session.ended',
	z.object({ memberId: z.string() }),
	// A transport signal only: no client is told.
	{ audience: [] },
);
/** A role's rights changed: every signed-in screen refreshes what it may show. */
export const roleChanged = defineEvent('core.role.changed', z.object({ roleId: z.string() }), {
	audience: ANY_MEMBER,
});

/** An area was turned on or off: navigation and displays follow. */
export const featuresChanged = defineEvent(
	'core.features.changed',
	z.object({ extensionId: z.string(), enabled: z.boolean() }),
	{ audience: EVERYONE },
);

export const aiAreasChanged = defineEvent(
	'core.aiAreas.changed',
	z.object({ extensionId: z.string(), access: z.enum(['off', 'local', 'any']) }),
	{ audience: CORE_CAPABILITIES.aiManage.id },
);

/** A provider or the model chosen for a job changed: family search brings its index in line. */
export const aiModelsChanged = defineEvent('core.aiModels.changed', z.object({}), {
	audience: CORE_CAPABILITIES.aiManage.id,
});

/** The display itself hears of it too: it checks again and falls back to pairing when revoked. */
export const deviceChanged = defineEvent(
	'core.device.changed',
	z.object({ deviceId: z.string() }),
	{ audience: (payload) => [CORE_CAPABILITIES.devicesManage.id, { device: payload.deviceId }] },
);
/** A display told what its screen had no room for (Settings → Devices shows it). */
export const displayFitChanged = defineEvent(
	'core.displayFit.changed',
	z.object({ deviceId: z.string() }),
	{ audience: CORE_CAPABILITIES.devicesManage.id },
);

/** A notification was created for a member (ids only): open tabs refresh their list and badge. */
export const notificationCreated = defineEvent(
	'core.notification.created',
	z.object({ memberId: z.string() }),
	{ audience: (payload) => ({ member: payload.memberId }) },
);
export const notificationRead = defineEvent(
	'core.notification.read',
	z.object({ memberId: z.string() }),
	{ audience: (payload) => ({ member: payload.memberId }) },
);

export const coreEvents = [
	draftCreated,
	conversationAnswered,
	draftUpdated,
	memberChanged,
	sessionEnded,
	roleChanged,
	deviceChanged,
	displayFitChanged,
	featuresChanged,
	aiAreasChanged,
	aiModelsChanged,
	notificationCreated,
	notificationRead,
];
