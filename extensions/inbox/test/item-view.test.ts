import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../src/contract/index.ts';
import type { Draft } from '../src/web/data.ts';
import {
	addsToTitle,
	askAssistantHref,
	captureLine,
	isAddition,
	isQuestionForAssistant,
	isWaiting,
	itemChip,
	itemPreview,
	itemTitle,
} from '../src/web/item-view.ts';

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
	id: 'inbox_item_1',
	channel: 'text',
	title: null,
	text: 'nereye gidiyor?',
	url: null,
	files: [],
	status: 'extracted',
	filedTo: null,
	transcript: null,
	summary: 'Soru',
	kind: 'question',
	errorCode: null,
	attempt: null,
	proposals: 0,
	skipped: 0,
	skippedUnknown: 0,
	createdBy: null,
	createdAt: 1,
	updatedAt: 1,
	...over,
});

describe('item view', () => {
	it('titles a short typed text with its own words and shows no preview', () => {
		expect(itemTitle(item())).toBe('nereye gidiyor?');
		expect(itemPreview(item())).toBe('');
	});
	it('only shows the label when it adds to the title', () => {
		expect(addsToTitle(item(), 'Soru')).toBe(true);
		expect(addsToTitle(item(), '  NEREYE   gidiyor? ')).toBe(false);
		expect(addsToTitle(item(), null)).toBe(false);
	});
	it('marks a question without proposals as a question for the assistant', () => {
		expect(isQuestionForAssistant(item())).toBe(true);
		expect(itemChip(item(), [])).toEqual({ tone: 'info', key: 'chip_question' });
		expect(isQuestionForAssistant(item({ proposals: 1 }))).toBe(false);
		expect(itemChip(item({ kind: 'nothing' }), []).key).toBe('chip_nothing');
		expect(itemChip(item({ kind: null }), []).key).toBe('chip_nothing');
	});
	it('links to the assistant with the text encoded', () => {
		expect(askAssistantHref(item({ text: 'a & b?' }))).toBe('/assistant?q=a%20%26%20b%3F');
	});
	it("names a capture by the model's label, else by its start", () => {
		expect(captureLine(item({ summary: 'A question' }))).toBe('A question');
		expect(captureLine(item({ summary: null, text: 'Buy milk' }))).toBe('Buy milk');
	});
});

describe('what waits for the person', () => {
	const draft = (status: Draft['status'], actionId = 'lists.addTask') =>
		({ id: 'd', status, actionId }) as Draft;
	const waits = (over: Partial<InboxItem>, drafts: Draft[], mine = true, seen = false) =>
		isWaiting({ item: item(over), drafts }, mine, seen);

	it('waits while it has a suggestion to decide, or a failed one', () => {
		expect(waits({}, [draft('pending')])).toBe(true);
		expect(waits({}, [draft('failed')])).toBe(true);
		expect(waits({}, [draft('applied'), draft('rejected')])).toBe(false);
		// Someone else's capture is only shown for what they must decide.
		expect(waits({ status: 'received' }, [], false)).toBe(false);
		expect(waits({}, [draft('pending')], false)).toBe(true);
	});
	it('waits while being read, after a failure, and while kept unread', () => {
		for (const status of ['received', 'normalized', 'failed', 'held'] as const)
			expect(waits({ status }, [])).toBe(true);
	});
	it('keeps a capture seen in this view when nothing came of it, until it is left', () => {
		expect(waits({ kind: 'nothing' }, [])).toBe(false);
		expect(waits({ kind: 'nothing' }, [], true, true)).toBe(true);
		// With decided suggestions it moves on to Recent.
		expect(waits({}, [draft('applied')], true, true)).toBe(false);
	});
	it('settles when its suggestions expired, like when they were all decided', () => {
		expect(waits({}, [draft('expired')])).toBe(false);
		expect(waits({}, [draft('expired'), draft('pending')])).toBe(true);
		expect(itemChip(item(), [draft('expired'), draft('expired')]).key).toBe('chip_expired');
		expect(itemChip(item(), [draft('expired'), draft('rejected')]).key).toBe('chip_rejected');
		expect(itemChip(item(), [draft('expired'), draft('applied')]).key).toBe('chip_added');
	});
	it('says added only when every applied suggestion was an add', () => {
		const add = draft('applied', 'calendar.createEvent');
		const removal = draft('applied', 'kitchen.removeMeal');
		expect(itemChip(item(), [add]).key).toBe('chip_added');
		expect(itemChip(item(), [removal]).key).toBe('chip_done');
		expect(itemChip(item(), [add, removal])).toMatchObject({ key: 'chip_done', count: 2 });
		expect(isAddition('lists.addShoppingItems')).toBe(true);
		expect(isAddition('lists.address')).toBe(false);
	});
	it('says taken back for suggestions that were approved and then undone', () => {
		expect(itemChip(item(), [draft('undone')]).key).toBe('chip_undone');
		expect(itemChip(item(), [draft('undone'), draft('expired')]).key).toBe('chip_undone');
		expect(itemChip(item(), [draft('undone'), draft('rejected')]).key).toBe('chip_rejected');
		expect(itemChip(item(), [draft('undone'), draft('applied')]).key).toBe('chip_added');
	});
});
