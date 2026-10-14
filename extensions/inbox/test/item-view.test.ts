import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../src/contract/index.ts';
import type { Draft } from '../src/web/data.ts';
import {
	addsToTitle,
	approveSelectedKey,
	askAssistantHref,
	captureLine,
	decidableCount,
	groupBusyState,
	isAddition,
	isQuestionForAssistant,
	isWaiting,
	itemChip,
	itemPreview,
	itemTitle,
	metaLine,
	needsAction,
	pickedByDefault,
	pickedDrafts,
	requestGroups,
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

describe('approveSelectedKey', () => {
	it('says "Add" only when every picked suggestion adds something', () => {
		expect(approveSelectedKey([{ actionId: 'lists.addShoppingItems' }])).toBe('add_selected');
		expect(
			approveSelectedKey([{ actionId: 'lists.addTask' }, { actionId: 'lists.checkShoppingItem' }]),
		).toBe('apply_selected');
		expect(approveSelectedKey([{ actionId: 'lists.completeTask' }])).toBe('apply_selected');
	});
});

describe('groupBusyState', () => {
	it('lets the group add and dismiss when no card is being edited', () => {
		expect(groupBusyState({ busy: false, editing: 0, picked: 2 })).toEqual({
			addDisabled: false,
			dismissDisabled: false,
			hint: false,
		});
	});

	it('holds both buttons, and says why, while a card edit is open', () => {
		expect(groupBusyState({ busy: false, editing: 1, picked: 2 })).toEqual({
			addDisabled: true,
			dismissDisabled: true,
			hint: true,
		});
	});

	it('holds Add with nothing picked and both while working', () => {
		expect(groupBusyState({ busy: false, editing: 0, picked: 0 })).toMatchObject({
			addDisabled: true,
			dismissDisabled: false,
		});
		expect(groupBusyState({ busy: true, editing: 0, picked: 1 })).toMatchObject({
			addDisabled: true,
			dismissDisabled: true,
		});
	});
});

describe('metaLine', () => {
	it('drops a field that only repeats the headline', () => {
		expect(metaLine('Sandpaper', ['Sandpaper', 'Hardware store'])).toBe('Hardware store');
		expect(metaLine('sandpaper ', ['Sandpaper'])).toBe('');
	});

	it('keeps the other values in order, then the extra notes', () => {
		expect(metaLine('Dentist', ['Tue 13', '10:00'], ['Check this'])).toBe(
			'Tue 13 \u00b7 10:00 \u00b7 Check this',
		);
	});
});

describe('needsAction', () => {
	const draft = (status: Draft['status']) => ({ id: 'd', status }) as Draft;
	it('is a suggestion to decide or to try again, which the Quick add badge counts too', () => {
		expect(needsAction(draft('pending'))).toBe(true);
		expect(needsAction(draft('failed'))).toBe(true);
		expect(needsAction(draft('applied'))).toBe(false);
	});
});

describe('requests that are not from a capture', () => {
	const request = (over: Partial<Draft>) =>
		({
			id: 'd',
			status: 'pending',
			actionId: 'lists.addTask',
			createdAt: 1,
			sourceKind: null,
			sourceId: null,
			proposedBy: { kind: 'member', memberId: 'noah' },
			canDecide: true,
			...over,
		}) as Draft;
	const app = (id: string, at: number, key = 'api_token_hermes') =>
		request({
			id,
			createdAt: at,
			sourceKind: 'mcp',
			sourceId: key,
			proposedBy: { kind: 'ai', source: 'mcp', onBehalfOf: 'sofia' },
		});

	it('groups them by where they came from, newest group first, each in the order made', () => {
		const groups = requestGroups([
			app('plasters', 3),
			app('delft', 1),
			app('other app', 2, 'api_token_other'),
			request({ id: 'asked', createdAt: 4 }),
			request({
				id: 'salad',
				createdAt: 5,
				sourceKind: 'assistant',
				sourceId: 'asst_msg_1',
				proposedBy: { kind: 'ai', source: 'assistant', onBehalfOf: 'sofia' },
			}),
		]);
		expect(groups.map((g) => [g.origin, g.drafts.map((d) => d.id)])).toEqual([
			['assistant', ['salad']],
			['person', ['asked']],
			['app', ['delft', 'plasters']],
			['app', ['other app']],
		]);
	});

	it('leaves out what is decided', () => {
		expect(
			requestGroups([request({ status: 'applied' }), request({ status: 'rejected' })]),
		).toEqual([]);
		expect(requestGroups([request({ status: 'failed' })])).toHaveLength(1);
	});

	it('counts what the person may decide, as the badge does', () => {
		expect(
			decidableCount([
				request({}),
				request({ status: 'failed' }),
				// Their own request, waiting for someone else.
				request({ canDecide: false }),
				request({ status: 'applied' }),
			]),
		).toBe(2);
	});
});

describe('what a group approves', () => {
	const offer = { actionId: 'calendar.changeEvent', input: { id: 'cal_event_1' } };
	const suggestion = (id: string, over: Partial<Draft> = {}) =>
		({ id, instead: null, mayExist: false, ...over }) as Draft;
	const gala = suggestion('gala', { instead: offer });
	const milk = suggestion('milk');
	const twice = suggestion('twice', { mayExist: true });
	const some = suggestion('some', { mayExistSome: true });

	it('starts with a suggestion that would add a second one unticked', () => {
		// "Regional Gala moved to the 14th" went in as a second gala with "Add selected".
		expect(pickedByDefault(gala)).toBe(false);
		expect(pickedByDefault(twice)).toBe(false);
		expect(pickedByDefault(milk)).toBe(true);
		// Only some of it is there: the rest is new, so it goes in.
		expect(pickedByDefault(some)).toBe(true);
		expect(pickedDrafts([gala, milk, twice, some], new Map()).map((d) => d.id)).toEqual([
			'milk',
			'some',
		]);
	});

	it('follows the person: a tick adds it, an untick leaves it out', () => {
		const choices = new Map([
			['gala', true],
			['milk', false],
		]);
		expect(pickedDrafts([gala, milk, twice], choices).map((d) => d.id)).toEqual(['gala']);
	});

	it('ticks the change the person chose instead, while it still shows its offer', () => {
		expect(pickedDrafts([gala], new Map([['gala', true]])).map((d) => d.id)).toEqual(['gala']);
		// Once the list catches up it is a change with no offer: ticked like any other.
		expect(pickedDrafts([suggestion('gala')], new Map()).map((d) => d.id)).toEqual(['gala']);
	});
});
