import { CORE_CAPABILITIES } from '@famos/core';
import { defineEvent } from '@famos/sdk';
import { z } from 'zod';

/**
 * Events of the host's own channels (the Telegram bot, the mailbox). They belong to no extension,
 * so each names its audience: the settings pages that show their state.
 */
export const telegramStatusChanged = defineEvent('telegram.status.changed', z.object({}), {
	audience: CORE_CAPABILITIES.settingsManage.id,
});
export const telegramLinkChanged = defineEvent(
	'telegram.link.changed',
	z.object({ memberId: z.string() }),
	{ audience: (payload) => [{ member: payload.memberId }, CORE_CAPABILITIES.settingsManage.id] },
);
export const emailStatusChanged = defineEvent('email.status.changed', z.object({}), {
	audience: CORE_CAPABILITIES.settingsManage.id,
});

export const hostEvents = [telegramStatusChanged, telegramLinkChanged, emailStatusChanged];
