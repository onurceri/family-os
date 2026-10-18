import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AnyDraftPresenter, PresenterContext, WebExtension } from '@famos/ui/slots';
import { beforeAll, describe, expect, it } from 'vitest';

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

describe('draft presenters', () => {
	// Every extension's web entry is loaded once; it pulls in its components, which is slow on a
	// busy machine.
	beforeAll(async () => {
		for (const extension of extensions) {
			const { default: web } = (await import(`../extensions/${extension}/src/web/index.ts`)) as {
				default: WebExtension;
			};
			for (const presenter of web.drafts ?? []) all.push({ extension, presenter });
		}
	}, 120_000);

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
});
