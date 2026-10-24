import { describe, expect, it, vi } from 'vitest';
import {
	createDraftFlow,
	type DraftCalls,
	type DraftFlowOptions,
	type DraftLike,
} from '../src/famos/draft-flow.svelte.js';

const draft = (over: Partial<DraftLike> = {}): DraftLike => ({
	id: 'draft_1',
	actionId: 'calendar.addEvent',
	status: 'pending',
	app: null,
	summary: null,
	titleKey: null,
	subject: null,
	quote: null,
	uncertainFields: [],
	forMember: null,
	autoApproved: false,
	undoable: false,
	reason: null,
	mayExist: false,
	mayExistSome: false,
	suggestedAgain: false,
	instead: null,
	before: null,
	unavailable: null,
	...over,
});

function setup(
	calls: Partial<DraftCalls<DraftLike>> = {},
	options: Partial<DraftFlowOptions<DraftLike>> = {},
) {
	const toast = vi.fn();
	const full: DraftCalls<DraftLike> = {
		approve: vi.fn(async () => draft({ status: 'applied', undoable: true })),
		reject: vi.fn(async () => draft({ status: 'rejected' })),
		undo: vi.fn(async () => draft({ status: 'undone' })),
		suggestAgain: vi.fn(async () => draft({ id: 'draft_2' })),
		replace: vi.fn(async () => draft({ actionId: 'calendar.moveEvent' })),
		wasUndone: () => false,
		...calls,
	};
	const flow = createDraftFlow<DraftLike>({
		given: () => draft(),
		calls: full,
		suggestAgain: 'mark',
		texts: () => ({ approved: 'Added', error: 'Failed', undo: 'Undo', suggestedAgain: 'Again' }),
		toast,
		...options,
	});
	return { flow, calls: full, toast };
}

describe('draft flow', () => {
	it('approves, offers Undo in the notice, and shows the draft undone after taking it back', async () => {
		const { flow, toast } = setup();
		await flow.approve();
		expect(flow.status).toBe('applied');
		expect(flow.undoable).toBe(true);
		expect(toast).toHaveBeenCalledWith('Added', expect.objectContaining({ label: 'Undo' }));
		toast.mock.calls[0]?.[1].run();
		await vi.waitFor(() => expect(flow.status).toBe('undone'));
		expect(flow.busy).toBe(false);
	});

	it('gives no Undo when the approval cannot be taken back', async () => {
		const { flow, toast } = setup({
			approve: async () => draft({ status: 'applied', undoable: false }),
		});
		await flow.approve();
		expect(toast).toHaveBeenCalledWith('Added', undefined);
		expect(flow.undoable).toBe(false);
	});

	it('closes a draft whose subject is gone, and says why', async () => {
		const { flow } = setup({
			approve: async () => draft({ status: 'rejected', reason: 'gone' }),
		});
		await flow.approve();
		expect(flow.status).toBe('rejected');
		expect(flow.reason).toBe('gone');
	});

	it('rejects, and withdraws with its own reason', async () => {
		const { flow } = setup();
		await flow.reject();
		expect(flow.status).toBe('rejected');
		expect(flow.reason).toBeNull();
		await flow.reject(true);
		expect(flow.reason).toBe('withdrawn');
	});

	it('shows a failed approval as failed, and a refusal too', async () => {
		const failed = setup({ approve: async () => draft({ status: 'failed' }) });
		await failed.flow.approve();
		expect(failed.flow.status).toBe('failed');
		expect(failed.flow.failed).toBe(true);

		const refused = setup({
			approve: async () => {
				throw new Error('refused');
			},
		});
		await refused.flow.approve();
		expect(refused.flow.status).toBe('failed');
		expect(refused.toast).not.toHaveBeenCalled();
	});

	it('shows a draft taken back on another screen as undone', async () => {
		const { flow } = setup({
			approve: async () => {
				throw new Error('undone');
			},
			wasUndone: () => true,
		});
		await flow.approve();
		expect(flow.status).toBe('undone');
	});

	it('says so in a notice when a call fails', async () => {
		const { flow, toast } = setup({
			reject: async () => {
				throw new Error('offline');
			},
		});
		await flow.reject();
		expect(toast).toHaveBeenCalledWith('Failed');
		expect(flow.status).toBe('pending');
		expect(flow.busy).toBe(false);
	});

	it('suggests a taken-back draft again: marked, or swapped into the card', async () => {
		const marked = setup();
		expect(marked.flow.canSuggestAgain).toBe(true);
		await marked.flow.suggestAgain();
		expect(marked.flow.canSuggestAgain).toBe(false);
		expect(marked.flow.draft.id).toBe('draft_1');
		expect(marked.toast).toHaveBeenCalledWith('Again');

		const swapped = setup({}, { suggestAgain: 'swap' });
		await swapped.flow.approve();
		await swapped.flow.undo('draft_1');
		await swapped.flow.suggestAgain();
		expect(swapped.flow.draft.id).toBe('draft_2');
		expect(swapped.flow.status).toBe('pending');
		expect(swapped.flow.failed).toBe(false);
	});

	it('turns into the change it offered instead, and tells the page', async () => {
		const onreplaced = vi.fn();
		const { flow } = setup({}, { onreplaced });
		await flow.choose();
		expect(flow.draft.actionId).toBe('calendar.moveEvent');
		expect(onreplaced).toHaveBeenCalled();
	});

	it('keeps a saved edit until told the list has it', async () => {
		const { flow } = setup({ edit: async (_id, input) => input });
		const after = vi.fn();
		await flow.saveEdit({ title: 'Soup' }, after);
		expect(flow.saved).toEqual({ title: 'Soup' });
		expect(after).toHaveBeenCalledWith({ title: 'Soup' });
		flow.forgetSaved();
		expect(flow.saved).toBeUndefined();
	});
});
