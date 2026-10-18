import { afterEach, describe, expect, it } from 'vitest';
import type { ActionAccess, AppContext, AwaitedChange } from '../src/app-context.js';
import {
	AwaitingRow,
	awaitingMarkText,
	awaitingRowText,
	DetailRows,
	editLabel,
	joinNames,
	readFirst,
	ViewOnly,
	viewOnlyLine,
} from '../src/famos/index.js';
import type { AnyDraftPresenter } from '../src/slots.js';
import WithApp from './fixtures/WithApp.svelte';
import { cleanup, click, html, key, q, render } from './helpers.js';

afterEach(cleanup);

const WORDS: Record<string, string> = {
	'app:view_only': 'View only',
	'app:view_only_why': 'Your role lets you see this. {{who}} can change what your role may do.',
	'app:view_only_why_unnamed':
		"Your role lets you see this. Someone who manages the family's roles can change what your role may do.",
	'app:today_names_and': '{{list}} and {{last}}',
	'app:suggest_change': 'Suggest a change',
	'app:draft_waiting': 'Waiting for approval',
	'app:draft_waiting_by': 'Suggested by {{name}}',
	'app:draft_waiting_change': 'Waiting for approval · {{change}}',
	'app:draft_waiting_change_by': 'Suggested by {{name}} · {{change}}',
	'app:draft_waiting_field': '{{label}}: {{value}}',
	'app:draft_kind_generic': 'Suggestion',
};
const t = (k: string, o: Record<string, unknown> = {}) =>
	(WORDS[k] ?? k).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(o[name] ?? ''));

const MEMBERS = [
	{ id: 'mara', displayName: 'Mara', color: '#111111' },
	{ id: 'tom', displayName: 'Tom', color: '#222222' },
	{ id: 'leo', displayName: 'Leo', color: '#333333' },
];

const treatment: AnyDraftPresenter = {
	actionId: 'pets.addTreatment',
	kind: () => 'Pets',
	title: (input: { product: string }) => input.product,
	fields: () => [],
};
const rename: AnyDraftPresenter = {
	actionId: 'calendar.updateEvent',
	kind: () => 'Calendar',
	title: () => 'Event',
	fields: (input: { title: string }) => [{ label: 'Title', value: input.title }],
};

function fakeApp(over: Partial<AppContext> = {}): AppContext {
	const answers: Record<string, ActionAccess> = {};
	return {
		t,
		members: () => MEMBERS,
		me: () => ({ ...MEMBERS[2], roleId: 'role_child', nextUp: 'family' }),
		formatLocale: () => 'en-GB',
		dateLocale: () => 'en-GB',
		weekStart: () => 1,
		hourCycle: () => 'h23',
		timeZone: () => 'UTC',
		draftPresenter: (id: string) => [treatment, rename].find((p) => p.actionId === id),
		access: (id: string) => answers[id] ?? 'apply',
		accessFor: (id: string) => answers[id] ?? 'apply',
		roleManagers: () => MEMBERS.slice(0, 2),
		...over,
	} as unknown as AppContext;
}

describe('the "View only" pill', () => {
	it('joins names the way a sentence does', () => {
		expect(joinNames([], t)).toBe('');
		expect(joinNames(['Mara'], t)).toBe('Mara');
		expect(joinNames(['Mara', 'Tom'], t)).toBe('Mara and Tom');
		expect(joinNames(['Mara', 'Tom', 'Ana'], t)).toBe('Mara, Tom and Ana');
	});

	it('names who can change roles, never the viewer, and says it in general when unknown', () => {
		expect(viewOnlyLine(MEMBERS.slice(0, 2), 'leo', t)).toBe(
			'Your role lets you see this. Mara and Tom can change what your role may do.',
		);
		expect(viewOnlyLine([MEMBERS[0] as (typeof MEMBERS)[0]], 'mara', t)).toContain(
			'Someone who manages',
		);
		expect(viewOnlyLine(undefined, 'leo', t)).toContain('Someone who manages');
	});

	it('says why on a tap (not on hover), announced, and closes with Escape', () => {
		render(WithApp, { app: fakeApp(), component: ViewOnly });
		const button = q('[data-testid=view-only] button');
		const why = q('[data-testid=view-only-why]');
		expect(button.textContent?.trim()).toBe('View only');
		expect(button.getAttribute('aria-expanded')).toBe('false');
		expect(why.getAttribute('aria-live')).toBe('polite');
		expect(why.textContent).toBe('');
		click(button);
		expect(button.getAttribute('aria-expanded')).toBe('true');
		expect(button.getAttribute('aria-controls')).toBe(why.id);
		expect(why.textContent).toBe(
			'Your role lets you see this. Mara and Tom can change what your role may do.',
		);
		key(document.body, 'Escape');
		expect(button.getAttribute('aria-expanded')).toBe('false');
		expect(why.textContent).toBe('');
	});
});

describe('reading first when a change waits for approval', () => {
	const details = html('<p>details</p>');
	const app = (answer: ActionAccess) => fakeApp({ access: () => answer, accessFor: () => answer });

	it('opens on the details with "Suggest a change" only for a suggestion', () => {
		expect(readFirst(app('suggest'), 'chores.updateChore', details, { key: 'c1' })).toEqual({
			details,
			label: 'Suggest a change',
			key: 'c1',
		});
		for (const answer of ['apply', 'no', 'depends'] as const)
			expect(readFirst(app(answer), 'chores.updateChore', details)).toBeUndefined();
	});

	it('asks for the exact answer when it is given the input', () => {
		const asked: unknown[] = [];
		const exact = fakeApp({
			access: () => 'depends',
			accessFor: (_id: string, input: unknown) => {
				asked.push(input);
				return 'suggest';
			},
		});
		expect(readFirst(exact, 'lists.updateTask', details, { input: { id: 't1' } })).toBeDefined();
		expect(asked).toEqual([{ id: 't1' }]);
		expect(editLabel(exact, 'lists.updateTask', 'Edit', { id: 't1' })).toBe('Suggest a change');
	});

	it("words a record page's edit button by the same answer", () => {
		expect(editLabel(app('suggest'), 'pets.updatePet', 'Edit')).toBe('Suggest a change');
		expect(editLabel(app('apply'), 'pets.updatePet', 'Edit')).toBe('Edit');
	});

	it('lists only the details that hold something', () => {
		const el = render(DetailRows, {
			rows: [
				{ label: 'Title', value: 'Piano lesson' },
				{ label: 'Notes', value: null },
				{ label: 'Where', value: '  ' },
			],
		});
		expect(el.querySelectorAll('dt').length).toBe(1);
		expect(el.textContent).toContain('Piano lesson');
	});
});

describe('what waits for approval', () => {
	const own: AwaitedChange = {
		actionId: 'calendar.updateEvent',
		input: { id: 'ev1', title: 'Piano lesson' },
		before: null,
	};
	const fromLeo: AwaitedChange = { ...own, by: 'leo' };
	const newTreatment: AwaitedChange = {
		draftId: 'draft_1',
		actionId: 'pets.addTreatment',
		input: { petId: 'pet_1', product: 'Rabies' },
		before: null,
		by: 'leo',
	};

	it('says what the change makes of it, and who asked to the one who decides', () => {
		const app = fakeApp();
		expect(awaitingMarkText(app, own)).toBe('Waiting for approval · Title: Piano lesson');
		expect(awaitingMarkText(app, fromLeo)).toBe('Suggested by Leo · Title: Piano lesson');
	});

	it('titles a new entry by its presenter, else in general words', () => {
		const app = fakeApp();
		expect(awaitingRowText(app, newTreatment)).toEqual({
			title: 'Rabies',
			meta: 'Suggested by Leo',
		});
		const { by: _, ...mine } = newTreatment;
		expect(awaitingRowText(app, mine).meta).toBe('Waiting for approval');
		expect(awaitingRowText(app, { ...mine, actionId: 'home.addService' }).title).toBe('Suggestion');
	});

	it('draws a new entry as a quiet row that opens nothing', () => {
		render(WithApp, { app: fakeApp(), component: AwaitingRow, props: { change: newTreatment } });
		const row = q('[data-testid=awaiting-row]');
		expect(row.tagName).toBe('DIV');
		expect(row.classList.contains('idle')).toBe(true);
		expect(row.textContent).toContain('Rabies');
		expect(row.textContent).toContain('Suggested by Leo');
		cleanup();
		render(WithApp, {
			app: fakeApp(),
			component: AwaitingRow,
			props: { change: { ...newTreatment, actionId: 'home.addService' }, title: 'City Power' },
		});
		expect(q('[data-testid=awaiting-row]').textContent).toContain('City Power');
	});
});
