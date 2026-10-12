import { afterEach, describe, expect, it, vi } from 'vitest';
import { draftHeadline, proposedByMember } from '../src/draft-title.js';
import { DraftCard } from '../src/famos/index.js';
import { cleanup, qa, render } from './helpers.js';

afterEach(cleanup);

const labels = {
	approve: 'Approve',
	edit: 'Edit',
	save: 'Save',
	cancel: 'Cancel',
	reject: 'Reject',
	rejectConfirm: 'Tap again',
	checkThis: 'Check this',
	applied: 'Added',
	rejected: 'Rejected',
	retry: 'Try again',
	expired: 'Its day has passed',
	gone: 'It no longer exists',
	withdrawn: 'Withdrawn',
	withdraw: 'Withdraw',
	waiting: 'Waiting for approval',
};
const card = (status: string, compact = false) =>
	render(DraftCard, {
		kind: 'Meal',
		title: 'Lentil soup',
		fields: [{ label: 'When', value: 'Saturday · Dinner' }],
		status,
		labels,
		compact,
		onapprove: vi.fn(),
		onreject: vi.fn(),
	});

describe('DraftCard', () => {
	it('shows an expired suggestion as settled: its day has passed, and no buttons', () => {
		for (const compact of [false, true]) {
			const el = card('expired', compact);
			expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe('Its day has passed');
			expect(qa('button', el)).toHaveLength(0);
			cleanup();
		}
	});

	it('says why a closed draft is closed', () => {
		const closed = (reason: 'gone' | 'withdrawn' | null) =>
			render(DraftCard, {
				kind: 'Meal',
				title: 'Lentil soup',
				fields: [],
				status: 'rejected',
				reason,
				labels,
				onapprove: vi.fn(),
				onreject: vi.fn(),
			});
		for (const [reason, text] of [
			['gone', 'It no longer exists'],
			['withdrawn', 'Withdrawn'],
			[null, 'Rejected'],
		] as const) {
			expect(closed(reason).querySelector('[role="status"]')?.textContent?.trim()).toBe(text);
			cleanup();
		}
	});

	it('lets the person behind a waiting suggestion withdraw it, and only them', () => {
		const onwithdraw = vi.fn();
		const waiting = (withdraw: boolean) =>
			render(DraftCard, {
				kind: 'Meal',
				title: 'Lentil soup',
				fields: [],
				status: 'pending',
				canDecide: false,
				labels,
				onapprove: vi.fn(),
				onreject: vi.fn(),
				...(withdraw && { onwithdraw }),
			});
		expect(qa('button', waiting(false))).toHaveLength(0);
		cleanup();
		const buttons = qa('button', waiting(true));
		expect(buttons.map((b) => b.textContent?.trim())).toEqual(['Withdraw']);
		buttons[0]?.click();
		expect(onwithdraw).toHaveBeenCalledOnce();
	});
});

describe('draftHeadline', () => {
	const t = (key: string) => `[${key}]`;
	const base = {
		summary: null,
		titleKey: 'vehicles:draft_title_remove_log',
		actionId: 'vehicles.removeLog',
		t,
	};

	it('uses the summary, else the translated action name with the label, else the id', () => {
		expect(draftHeadline({ ...base, summary: 'Invoice', input: {} })).toBe('Invoice');
		expect(draftHeadline({ ...base, input: { label: ' Oil change ' } })).toBe(
			'[vehicles:draft_title_remove_log] · Oil change',
		);
		expect(draftHeadline({ ...base, input: {} })).toBe('[vehicles:draft_title_remove_log]');
		expect(draftHeadline({ ...base, titleKey: null, input: {} })).toBe('vehicles.removeLog');
	});

	it('knows whether the member is behind a draft', () => {
		expect(proposedByMember({ kind: 'member', memberId: 'm1' }, 'm1')).toBe(true);
		expect(proposedByMember({ kind: 'ai', source: 'mcp', onBehalfOf: 'm1' }, 'm1')).toBe(true);
		expect(proposedByMember({ kind: 'ai', source: 'inbox' }, 'm1')).toBe(false);
		expect(proposedByMember({ kind: 'member', memberId: 'm2' }, 'm1')).toBe(false);
		expect(proposedByMember({ kind: 'member', memberId: 'm1' }, undefined)).toBe(false);
	});
});
