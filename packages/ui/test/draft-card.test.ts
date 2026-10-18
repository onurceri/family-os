import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	askedBy,
	draftHeadline,
	draftKicker,
	namedInput,
	proposedByMember,
	unavailableLine,
} from '../src/draft-title.js';
import { DraftCard, draftButtons } from '../src/famos/index.js';
import { awaitingText, changed, changedValue, insteadOffer } from '../src/slots.js';
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

	it('marks the title when which thing it changes is a guess and no field shows it', () => {
		const guessed = (fields: { label: string; value: string; path?: string }[]) =>
			render(DraftCard, {
				kind: 'Event',
				title: 'Swim lesson',
				fields,
				uncertain: ['id'],
				status: 'pending',
				labels,
				onapprove: vi.fn(),
				onreject: vi.fn(),
			});
		expect(guessed([]).querySelector('h3')?.textContent).toContain('Check this');
		cleanup();
		// A field that shows the target carries the mark itself, once.
		const shown = guessed([{ label: 'Change', value: 'Mark done', path: 'id' }]);
		expect(shown.querySelector('h3')?.textContent).not.toContain('Check this');
		expect(shown.querySelector('dl')?.textContent).toContain('Check this');
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

	it('lets the person behind an undone suggestion suggest it again, on both layouts', () => {
		const onsuggestagain = vi.fn();
		const undone = (compact: boolean, again: boolean) =>
			render(DraftCard, {
				kind: 'Meal',
				title: 'Lentil soup',
				fields: [],
				status: 'undone',
				compact,
				labels: { ...labels, undone: 'Undone', suggestAgain: 'Suggest again' },
				onapprove: vi.fn(),
				onreject: vi.fn(),
				...(again && { onsuggestagain }),
			});
		for (const compact of [false, true]) {
			expect(qa('button', undone(compact, false))).toHaveLength(0);
			cleanup();
			const buttons = qa('button', undone(compact, true));
			expect(buttons.map((b) => b.textContent?.trim())).toEqual(['Suggest again']);
			buttons[0]?.click();
			cleanup();
		}
		expect(onsuggestagain).toHaveBeenCalledTimes(2);
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

	it('names the thing by the subject the server read when the input carries no label', () => {
		expect(draftHeadline({ ...base, input: { id: 'x' }, subject: 'Oil change' })).toBe(
			'[vehicles:draft_title_remove_log] · Oil change',
		);
		expect(draftHeadline({ ...base, titleKey: null, input: {}, subject: 'Oil change' })).toBe(
			'Oil change',
		);
		expect(namedInput({ id: 'x' }, 'Piano lesson')).toEqual({ id: 'x', label: 'Piano lesson' });
		expect(namedInput({ id: 'x', label: 'Piano' }, 'Piano lesson')).toEqual({
			id: 'x',
			label: 'Piano',
		});
		expect(namedInput({ id: 'x' }, null)).toEqual({ id: 'x' });
	});

	it('titles a card by what it is about, not by the group line the capture gave', () => {
		// Found in use: a board note in Ivy's piano group was titled with the group's own line.
		const board = {
			summary: 'Piano recital and practice',
			titleKey: null,
			actionId: 'board.postNote',
			t,
		};
		expect(
			draftHeadline({
				...board,
				input: { text: 'No phones in the hall' },
				subject: 'No phones in the hall',
			}),
		).toBe('No phones in the hall');
		expect(draftHeadline({ ...board, input: {}, subject: ' Bring water ' })).toBe('Bring water');
		expect(draftHeadline({ ...board, input: { label: 'Water' }, subject: 'Bring water' })).toBe(
			'Water',
		);
		// With nothing to name, the summary is all there is.
		expect(draftHeadline({ ...board, input: {}, subject: null })).toBe(
			'Piano recital and practice',
		);
	});

	it('says which extension a waiting suggestion needs, in the reader’s language', () => {
		const say = (key: string, options?: Record<string, unknown>) =>
			`${key}:${String(options?.name)}`;
		const pets = {
			reason: 'not_installed' as const,
			extension: 'pets',
			labels: { en: 'Pets', tr: 'Evcil hayvanlar' },
		};
		expect(unavailableLine(pets, 'tr', say)).toBe('app:draft_not_installed:Evcil hayvanlar');
		expect(unavailableLine(pets, 'de', say)).toBe('app:draft_not_installed:Pets');
		expect(unavailableLine({ ...pets, reason: 'turned_off' }, 'en', say)).toBe(
			'app:draft_turned_off:Pets',
		);
		expect(unavailableLine({ ...pets, labels: {} }, 'en', say)).toBe(
			'app:draft_not_installed:pets',
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

describe('a suggestion that offers to change what is already there', () => {
	const offered = (onchoose = vi.fn(), onapprove = vi.fn(), canDecide = true) =>
		render(DraftCard, {
			kind: 'Calendar',
			title: 'Regional gala',
			fields: [],
			status: 'pending',
			labels: { ...labels, addAsNew: 'Add as new', mayExist: 'This may already be there' },
			mayExist: true,
			canDecide,
			instead: {
				there: 'Already on the calendar: Regional Gala · Sat 7 Nov 18:00',
				action: 'Move it to Sat 14 Nov 09:00 instead',
				onchoose,
			},
			onapprove,
			onreject: vi.fn(),
		});
	const button = (el: HTMLElement, text: string) =>
		qa('button', el).find((b) => b.textContent?.trim() === text) as HTMLElement;

	it('says what is there and moves it with one tap; adding it as new takes two', () => {
		const onchoose = vi.fn();
		const onapprove = vi.fn();
		const el = offered(onchoose, onapprove);
		expect(el.textContent).toContain('Already on the calendar: Regional Gala · Sat 7 Nov 18:00');
		expect(el.textContent).not.toContain('This may already be there');
		click(button(el, 'Move it to Sat 14 Nov 09:00 instead'));
		expect(onchoose).toHaveBeenCalledOnce();
		const addNew = button(el, 'Add as new');
		click(addNew);
		expect(onapprove).not.toHaveBeenCalled();
		click(addNew);
		expect(onapprove).toHaveBeenCalledOnce();
	});

	it('makes the move the filled button and adding it as new a secondary one', () => {
		// The card pushed people to the duplicate: "Add as new" was the filled button.
		const el = offered();
		const move = button(el, 'Move it to Sat 14 Nov 09:00 instead');
		const addNew = button(el, 'Add as new');
		expect(move.className).toContain('bg-attention');
		expect(addNew.className).not.toContain('bg-attention');
		expect(addNew.className).toContain('bg-idle');
	});

	it('in a group, offers the move as an outline beside the tick: the group has the filled one', () => {
		const onchoose = vi.fn();
		const el = render(DraftCard, {
			kind: 'Calendar',
			title: 'Regional gala',
			fields: [],
			status: 'pending',
			labels: { ...labels, addAsNew: 'Add as new' },
			quiet: true,
			selectable: { checked: false, label: 'Pick', onchange: vi.fn() },
			instead: {
				there: 'Already on the calendar: Regional Gala · Sat 7 Nov 18:00',
				action: 'Move it to Sat 14 Nov 09:00 instead',
				onchoose,
			},
			onapprove: vi.fn(),
			onreject: vi.fn(),
		});
		const move = button(el, 'Move it to Sat 14 Nov 09:00 instead');
		expect(move.className).toContain('border');
		expect(move.className).not.toContain('bg-ink');
		expect(button(el, 'Add as new')).toBeUndefined();
		click(move);
		expect(onchoose).toHaveBeenCalledOnce();
	});

	it('is not offered to someone who cannot decide', () => {
		const el = offered(vi.fn(), vi.fn(), false);
		expect(el.textContent).not.toContain('instead');
		expect(el.textContent).toContain('Waiting for approval');
	});
});

describe('insteadOffer', () => {
	const t = (key: string, options?: Record<string, unknown>) =>
		options ? `${key} ${JSON.stringify(options)}` : key;
	const context = {
		t,
		members: [],
		formatLocale: 'en-GB',
		dateLocale: 'en-GB',
		weekStart: 1,
		hourCycle: 'h23' as const,
		timeZone: 'UTC',
	};
	const instead = {
		actionId: 'shelf.move',
		input: { id: 'thing_1', label: ' Reading lamp ' },
		at: { date: '2026-11-07' },
	};

	it('is nothing without an alternative', () => {
		expect(insteadOffer({ instead: null, presenter: undefined, context, t })).toBeUndefined();
	});

	it('lets the presenter of the alternative word it', () => {
		const presenter = {
			actionId: 'shelf.move',
			kind: () => 'Shelf',
			title: () => 'Move',
			fields: () => [],
			instead: (input: { label: string }, at: { date: string } | undefined) => ({
				there: `${input.label.trim()} on ${at?.date}`,
				action: 'Move it',
			}),
		};
		expect(insteadOffer({ instead, presenter, context, t })).toEqual({
			there: 'Reading lamp on 2026-11-07',
			action: 'Move it',
		});
	});

	it('names what is there by its real title when no presenter words it', () => {
		expect(insteadOffer({ instead, presenter: undefined, context, t })).toEqual({
			there: 'app:draft_instead_there {"name":"Reading lamp"}',
			action: 'app:draft_instead',
		});
		expect(
			insteadOffer({
				instead: { ...instead, input: { id: 'x' } },
				presenter: undefined,
				context,
				t,
			}),
		).toEqual({ there: 'app:draft_instead_there_unnamed', action: 'app:draft_instead' });
	});
});

describe('draftButtons', () => {
	it('makes the offered change the primary action of a card decided on its own', () => {
		expect(draftButtons({ offered: true, warned: true, picking: false })).toEqual({
			offer: 'primary',
			approve: 'secondary-confirm',
		});
	});

	it('keeps the group button the one filled button', () => {
		expect(draftButtons({ offered: true, warned: true, picking: true })).toEqual({
			offer: 'outline',
			approve: 'none',
		});
		expect(draftButtons({ offered: false, warned: false, picking: true })).toEqual({
			offer: 'none',
			approve: 'none',
		});
	});

	it('asks a second tap to approve what may already be there', () => {
		expect(draftButtons({ offered: false, warned: true, picking: false }).approve).toBe(
			'primary-confirm',
		);
		expect(draftButtons({ offered: false, warned: false, picking: false }).approve).toBe('primary');
	});
});

describe('changedValue', () => {
	it('reads old → new when the old value is known and differs', () => {
		expect(changedValue('1 l', '2 l')).toBe('1 l → 2 l');
		expect(changedValue('2 l', '2 l')).toBe('2 l');
		expect(changedValue(undefined, '2 l')).toBe('2 l');
	});
});

describe('awaitingText', () => {
	const context = {
		t: (key: string, o?: Record<string, unknown>) =>
			key === 'app:draft_waiting_change'
				? `Waiting for approval · ${String(o?.change)}`
				: key === 'app:draft_waiting_field'
					? `${String(o?.label)}: ${String(o?.value)}`
					: key === 'app:draft_waiting'
						? 'Waiting for approval'
						: key,
		members: [],
		formatLocale: 'en-GB',
		dateLocale: 'en-GB',
		weekStart: 1,
		hourCycle: 'h23' as const,
		timeZone: 'UTC',
	};
	const presenter = (fields: () => { label: string; value: string; to?: string }[]) => ({
		actionId: 'x.change',
		kind: () => 'Change',
		title: () => 'Thing',
		fields,
	});

	it('says what the change will make of the thing, with each new value alone', () => {
		const text = awaitingText({
			input: {},
			before: { due: null },
			presenter: presenter(() => [
				{ label: 'Due', ...changed('No date', 'Tue 20 Oct') },
				{ label: 'Who', value: 'Ivy' },
			]),
			context,
		});
		expect(text).toBe('Waiting for approval · Due: Tue 20 Oct, Who: Ivy');
	});

	it('says only that it waits without a presenter, rows, or with an input that does not fit', () => {
		const plain = (p: ReturnType<typeof presenter> | undefined) =>
			awaitingText({ input: {}, before: null, presenter: p, context });
		expect(plain(undefined)).toBe('Waiting for approval');
		expect(plain(presenter(() => []))).toBe('Waiting for approval');
		expect(
			plain(
				presenter(() => {
					throw new Error('old input');
				}),
			),
		).toBe('Waiting for approval');
	});
});
