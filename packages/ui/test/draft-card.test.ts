import { afterEach, describe, expect, it, vi } from 'vitest';
import { askedBy, draftHeadline, draftKicker, proposedByMember } from '../src/draft-title.js';
import { DraftCard } from '../src/famos/index.js';
import { cleanup, click, qa, render } from './helpers.js';

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
	settled: 'Already done',
	approveConfirm: 'Tap again to add it anyway',
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
		const closed = (reason: 'gone' | 'settled' | 'withdrawn' | null) =>
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
			['settled', 'Already done'],
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

describe('approving a suggestion that may already be there', () => {
	const pending = (flags: { mayExist?: boolean; mayExistSome?: boolean }, onapprove = vi.fn()) =>
		render(DraftCard, {
			kind: 'Task',
			title: 'Call the dentist',
			fields: [],
			status: 'pending',
			labels,
			onapprove,
			onreject: vi.fn(),
			...flags,
		});
	const approveButton = (el: HTMLElement) =>
		qa('button', el).find((b) =>
			/^(Approve|Tap again to add it anyway)$/.test(b.textContent?.trim() ?? ''),
		);

	it('takes a second tap, as rejecting does', () => {
		for (const flags of [{ mayExist: true }, { mayExistSome: true }]) {
			const onapprove = vi.fn();
			const button = approveButton(pending(flags, onapprove)) as HTMLElement;
			click(button);
			expect(onapprove).not.toHaveBeenCalled();
			expect(button.textContent?.trim()).toBe('Tap again to add it anyway');
			click(button);
			expect(onapprove).toHaveBeenCalledOnce();
			cleanup();
		}
	});

	it('stays one tap when nothing suggests a duplicate', () => {
		const onapprove = vi.fn();
		click(approveButton(pending({}, onapprove)) as HTMLElement);
		expect(onapprove).toHaveBeenCalledOnce();
	});
});

describe('who asked', () => {
	it('is shown on the card when given', () => {
		const el = render(DraftCard, {
			kind: 'Task',
			title: 'Call the dentist',
			fields: [],
			status: 'pending',
			labels,
			askedBy: 'Asked by Noah',
			onapprove: vi.fn(),
			onreject: vi.fn(),
		});
		expect(el.textContent).toContain('Asked by Noah');
	});

	it('names the member behind a suggestion only when it is somebody else', () => {
		const members = [
			{ id: 'm1', displayName: 'Ayse' },
			{ id: 'm2', displayName: 'Noah' },
		];
		expect(askedBy({ kind: 'ai', source: 'assistant', onBehalfOf: 'm2' }, 'm1', members)).toBe(
			'Noah',
		);
		expect(askedBy({ kind: 'member', memberId: 'm2' }, 'm1', members)).toBe('Noah');
		expect(
			askedBy({ kind: 'ai', source: 'assistant', onBehalfOf: 'm1' }, 'm1', members),
		).toBeUndefined();
		expect(askedBy({ kind: 'ai', source: 'inbox' }, 'm1', members)).toBeUndefined();
		expect(askedBy({ kind: 'member', memberId: 'gone' }, 'm1', members)).toBeUndefined();
	});
});

describe('draftKicker', () => {
	const names: Record<string, string> = {
		'kitchen:nav': 'Kitchen',
		'app:draft_kind_generic': 'Suggestion',
	};
	// A missing key comes back as itself, or as its last part, as i18next does.
	const t = (key: string) => names[key] ?? key.split(':').pop() ?? key;

	it('is the extension’s name, else a generic word, never an action id', () => {
		expect(draftKicker({ actionId: 'kitchen.removeMealPlanEntry', t })).toBe('Kitchen');
		expect(draftKicker({ actionId: 'records.removeThing', t })).toBe('Suggestion');
		expect(draftKicker({ actionId: 'core.addMemory', t })).toBe('Suggestion');
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

	it('uses the summary, else the translated action name with the label, else a generic word', () => {
		expect(draftHeadline({ ...base, summary: 'Invoice', input: {} })).toBe('Invoice');
		expect(draftHeadline({ ...base, input: { label: ' Oil change ' } })).toBe(
			'[vehicles:draft_title_remove_log] · Oil change',
		);
		expect(draftHeadline({ ...base, input: {} })).toBe('[vehicles:draft_title_remove_log]');
		expect(draftHeadline({ ...base, titleKey: null, input: {}, t: (key) => `[${key}]` })).toBe(
			'[app:draft_kind_generic]',
		);
	});

	it('knows whether the member is behind a draft', () => {
		expect(proposedByMember({ kind: 'member', memberId: 'm1' }, 'm1')).toBe(true);
		expect(proposedByMember({ kind: 'ai', source: 'mcp', onBehalfOf: 'm1' }, 'm1')).toBe(true);
		expect(proposedByMember({ kind: 'ai', source: 'inbox' }, 'm1')).toBe(false);
		expect(proposedByMember({ kind: 'member', memberId: 'm2' }, 'm1')).toBe(false);
		expect(proposedByMember({ kind: 'member', memberId: 'm1' }, undefined)).toBe(false);
	});
});
