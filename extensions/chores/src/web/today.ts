import type { MemberCountsFacet, TodayBlockContribution } from '@famos/ui/slots';
import { loadTodayByMember } from './data.js';

/** The chores of Today: one block, which the rings and the chores card share. */
export const choresBlock: TodayBlockContribution = {
	// The block's id is the one people have hidden it by since it was the app's own.
	id: 'chores',
	labelKey: 'chores:today_block',
	hintKey: 'chores:today_block_hint',
	// Between where everyone is (70) and Needs you (90).
	order: 80,
};

/**
 * Today's chores per person, as the rings (and Lanes' bars, a display's total, the "2 chores
 * left" under a person's day) count them. Read through `GET /chores/today`, which a display may
 * call; the same read as the chores card, so they share it.
 */
export const choresToday: MemberCountsFacet = {
	kind: 'perMember',
	id: 'chores.today',
	requires: 'chores.view',
	block: choresBlock.id,
	href: '/chores',
	titleKey: 'chores:today_title',
	labelKey: 'chores:today_counts_label',
	ringKey: 'chores:today_ring',
	leftKey: 'chores:today_left',
	invalidateOn: ['chores.'],
	load: () => loadTodayByMember(),
};
