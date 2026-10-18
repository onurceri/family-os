import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AnyActionDefinition, ExtensionDefinition } from '@famos/sdk';
import type { AnyDraftPresenter, PresenterContext, WebExtension } from '@famos/ui/slots';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { draftHeadline } from '../packages/ui/src/draft-title.ts';

const root = join(import.meta.dirname, '..');
const extensions = readdirSync(join(root, 'extensions')).filter((name) =>
	statSync(join(root, 'extensions', name)).isDirectory(),
);

const ISO = /\d{4}-\d{2}-\d{2}/;
const DAY = '2026-09-02';
const OLD_DAY = '2026-08-17';

// Translations echo their key and parameters, so a date handed to `t` unformatted shows too.
const context: PresenterContext = {
	t: (key, options) => (options ? `${key} ${JSON.stringify(options)}` : key),
	members: [{ id: 'mem_a', displayName: 'Ayse', color: 'sky' }],
	formatLocale: 'en-GB',
	dateLocale: 'en-GB',
	weekStart: 1,
	hourCycle: 'h23',
	timeZone: 'Europe/Istanbul',
};

// One input that carries a date under every name an action uses, plus the other shapes presenters
// read, so each presenter finds what it needs whatever its action's input looks like.
function sample(day: string): Record<string, unknown> {
	const task = {
		title: 'Task',
		dueDate: day,
		dueTime: '18:00',
		assigneeId: 'mem_a',
		recurrence: { freq: 'weekly', byDay: ['TH'] },
		notes: 'Note',
	};
	const event = {
		title: 'Event',
		allDay: false,
		date: day,
		endDate: day,
		startTime: '18:00',
		endTime: '19:00',
		memberIds: ['mem_a'],
		location: 'School',
		notes: 'Note',
		recurrence: { freq: 'weekly', interval: 1, byDay: ['TH'] },
		reminder: 15,
		tags: ['school'],
	};
	return {
		event,
		occurrence: day,
		id: 'x_1',
		label: 'Label',
		name: 'Name',
		title: 'Title',
		date: day,
		endDate: day,
		startDate: day,
		dueDate: day,
		dueTime: '18:00',
		start: '18:00',
		end: '19:00',
		startTime: '18:00',
		endTime: '19:00',
		givenOn: day,
		doneOn: day,
		nextDueDate: day,
		purchasedOn: day,
		warrantyUntil: day,
		recordName: 'Record',
		slot: 'dinner',
		kind: 'service',
		species: 'cat',
		recurrence: { freq: 'weekly', interval: 1, byDay: ['TH'] },
		assigneeIds: ['mem_a'],
		assigneeId: 'mem_a',
		memberIds: ['mem_a'],
		doneBy: 'mem_a',
		rotation: 'rotate',
		items: [{ title: 'Milk', quantity: '2' }],
		ingredients: ['milk'],
		steps: ['stir'],
		task,
		done: true,
		notes: 'Note',
	};
}

const all: { extension: string; presenter: AnyDraftPresenter }[] = [];
const actions = new Map<string, AnyActionDefinition>();

// The fields of an action's input that hold a calendar day, by the names such fields have
// (dueDate, givenOn, warrantyUntil, occurrence…). The schema is walked without a library: objects
// have a `shape`, wrappers an `unwrap()`, unions `options`. Lists are not entered: what a preset
// carries is not what the card is about.
const DATE_FIELD = /^(date|occurrence|until)$|(Date|On|Until)$/;
function dateFields(schema: unknown, seen = new Set<unknown>()): string[] {
	if (typeof schema !== 'object' || schema === null || seen.has(schema)) return [];
	seen.add(schema);
	const node = schema as {
		shape?: Record<string, unknown>;
		unwrap?: () => unknown;
		element?: unknown;
		options?: unknown[];
	};
	if (node.shape)
		return Object.entries(node.shape).flatMap(([key, field]) =>
			DATE_FIELD.test(key) ? [key] : dateFields(field, seen),
		);
	if (node.element) return [];
	if (typeof node.unwrap === 'function') return dateFields(node.unwrap(), seen);
	return (node.options ?? []).flatMap((option) => dateFields(option, seen));
}

// Whole replacement and partial change of the same thing say the same to a person.
const SAME_TO_A_PERSON = [
	['calendar.changeEvent', 'calendar.updateEvent'],
	['lists.changeTask', 'lists.updateTask'],
];

// What a person reads of a day: a month name (the translation stub only echoes keys, so a day in
// words can only come from a date formatter).
// The sample, with the action's own date fields filled in whatever they are called.
function withDates(input: Record<string, unknown>, action: AnyActionDefinition, day: string) {
	return { ...input, ...Object.fromEntries(dateFields(action.input).map((key) => [key, day])) };
}

const A_DAY_IN_WORDS = /\bSep(t|tember)?\b/;
// A title that is only a translation key names nothing: it is the kind's generic noun.
const BARE_KEY = /^[\w-]+:[\w.-]+$/;

describe('draft presenters', () => {
	// Every extension's web entry is loaded once; it pulls in its components, which is slow on a
	// busy machine.
	beforeAll(async () => {
		// Far before the sample day, so a day reads as a date and not as "3 days ago".
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-01-01T09:00:00Z'));
		for (const extension of extensions) {
			const { default: web } = (await import(`../extensions/${extension}/src/web/index.ts`)) as {
				default: WebExtension;
			};
			for (const presenter of web.drafts ?? []) all.push({ extension, presenter });
			const { default: server } = (await import(
				`../extensions/${extension}/src/server/index.ts`
			)) as {
				default: ExtensionDefinition;
			};
			for (const action of server.actions) actions.set(action.id, action);
		}
	}, 120_000);

	afterAll(() => vi.useRealTimers());

	it('are found in the extensions that have them', () => {
		const found = all.map((p) => p.presenter.actionId);
		expect(found).toContain('pets.addTreatment');
		expect(found).toContain('calendar.createEvent');
		expect(found.length).toBeGreaterThan(20);
	});

	it('name the weekday of a repeat once when it is the day the thing starts', () => {
		// 2026-09-03 is a Thursday.
		const input = { ...sample('2026-09-03'), recurrence: { freq: 'weekly', byDay: ['TH'] } };
		for (const id of ['lists.addTask', 'calendar.createEvent']) {
			const found = all.find((p) => p.presenter.actionId === id);
			const row = JSON.stringify(found?.presenter.fields(input, context));
			expect(row, id).toContain('repeat_weekly_on');
			expect(row, id).not.toContain('repeat_weekly ');
		}
	});

	it('write no raw YYYY-MM-DD date in any text they show', () => {
		const offenders: string[] = [];
		for (const { presenter } of all) {
			const input = sample(DAY);
			const before = sample(OLD_DAY);
			for (const known of [undefined, before]) {
				const shown = JSON.stringify([
					presenter.kind(context),
					presenter.title(input, context),
					presenter.fields(input, context, known),
				]);
				if (ISO.test(shown)) offenders.push(`${presenter.actionId}: ${shown}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('show the day of a change whose input has one', () => {
		const offenders: string[] = [];
		for (const { presenter } of all) {
			const action = actions.get(presenter.actionId);
			// A change limited to one day of a repeating event says which, in words, by its scope note.
			if (!action || action.scopeNote || !dateFields(action.input).length) continue;
			const input = withDates(sample(DAY), action, DAY);
			const shown = JSON.stringify([
				presenter.title(input, context),
				presenter.fields(input, context),
			]);
			if (!A_DAY_IN_WORDS.test(shown)) offenders.push(`${presenter.actionId}: ${shown}`);
		}
		expect(offenders).toEqual([]);
	});

	it('belong to an action the server defines', () => {
		expect(
			all.filter((p) => !actions.has(p.presenter.actionId)).map((p) => p.presenter.actionId),
		).toEqual([]);
	});

	it('are found for actions the server defines, and the walk finds dates', () => {
		expect(actions.get('lists.addTask')).toBeDefined();
		expect(dateFields(actions.get('lists.addTask')?.input)).toContain('dueDate');
		expect(dateFields(actions.get('pets.addPet')?.input)).toEqual(['birthDate']);
		expect(dateFields(actions.get('home.addHome')?.input)).toEqual([]);
	});

	it('title a card by the thing it is about, never by the kind alone', () => {
		const offenders: string[] = [];
		for (const { presenter } of all) {
			const title = presenter.title(sample(DAY), context);
			if (!title.trim() || BARE_KEY.test(title) || title === presenter.kind(context))
				offenders.push(`${presenter.actionId}: "${title}"`);
		}
		expect(offenders).toEqual([]);
	});

	it('give two actions of one extension different names to a screen reader', () => {
		// What a card is called by the tick that includes it and by its approve button.
		const names = new Map<string, string>();
		const offenders: string[] = [];
		for (const { extension, presenter } of all) {
			const name = [
				presenter.kind(context),
				presenter.title(sample(DAY), context),
				presenter.approveLabel?.(context) ?? '',
			].join(' | ');
			const key = `${extension} ${name}`;
			const other = names.get(key);
			const alias = SAME_TO_A_PERSON.some(
				(pair) => pair.includes(presenter.actionId) && other && pair.includes(other),
			);
			if (other && !alias) offenders.push(`${other} and ${presenter.actionId}: ${name}`);
			names.set(key, presenter.actionId);
		}
		expect(offenders).toEqual([]);
	});
});

describe('a card without a presenter', () => {
	const t = (key: string) => key;
	const GROUP = 'Piano recital and practice';

	it('is never titled by the group line or a generic word, whichever action it is', () => {
		const offenders: string[] = [];
		for (const [id, action] of actions) {
			if (action.readOnly || !action.ai) continue;
			for (const subject of [null, 'Name on record']) {
				const headline = draftHeadline({
					summary: GROUP,
					groupLine: GROUP,
					titleKey: action.draftTitle ?? null,
					actionId: id,
					input: { id: 'x_1' },
					subject,
					t,
				});
				if (headline === GROUP || headline === 'app:draft_kind_generic')
					offenders.push(`${id} (${subject ?? 'no subject'}): ${headline}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
