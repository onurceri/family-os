import { defineCapability, defineEvent, defineNotificationKind } from '@famos/sdk';
import { BOARD_MANAGE, BOARD_POST, BOARD_VIEW, boardChangedPayload } from '../contract/index.ts';

/**
 * What the board protects. The levels give the defaults: everyone (guests
 * and family displays included) reads, everyone but guests writes, only admins manage.
 */
export const boardView = defineCapability({
	id: BOARD_VIEW,
	label: 'board:cap_view',
	level: 'view',
});
export const boardPost = defineCapability({
	id: BOARD_POST,
	label: 'board:cap_post',
	level: 'use',
});
export const boardManage = defineCapability({
	id: BOARD_MANAGE,
	label: 'board:cap_manage',
	level: 'manage',
});

export const boardChanged = defineEvent('board.changed', boardChangedPayload, {
	audience: BOARD_VIEW,
	changes: ({ noteId, noteIds, op }) =>
		[...(noteId ? [noteId] : []), ...(noteIds ?? [])].map((id) => ({
			entity: 'note',
			id,
			op: op ?? 'upsert',
		})),
});

/** A new note: everyone who sees the board, except the author. */
export const postedKind = defineNotificationKind({
	id: 'board.posted',
	label: 'board:notify_kind_posted',
	audience: BOARD_VIEW,
});
