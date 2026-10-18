import { describe, expect, it } from 'vitest';
import {
	addablePages,
	listedPages,
	movePage,
	pagesChanged,
	rotationToSave,
	withCurrent,
} from './display-pages.js';

const contributions = [
	{ slot: 'display.page', id: 'homeassistant.values', requires: 'homeassistant.view' },
	{ slot: 'display.page', id: 'calendar.week', requires: 'calendar.view' },
	{ slot: 'display.page', id: 'board.notes', requires: 'board.view' },
	{ slot: 'display.widget', id: 'homeassistant.widget', requires: 'homeassistant.view' },
	{ slot: 'display.page', id: 'nothing.required' },
];

describe('addablePages', () => {
	it('offers the pages whose permission is ticked, and nothing else', () => {
		const ids = addablePages(contributions, ['calendar.view', 'board.view'], [], []).map(
			(c) => c.id,
		);
		expect(ids).toEqual(['calendar.week', 'board.notes']);
	});

	it('leaves out pages already in the list and those of extensions turned off', () => {
		const ids = addablePages(
			contributions,
			['calendar.view', 'board.view', 'homeassistant.view'],
			['calendar.week'],
			['board'],
		).map((c) => c.id);
		expect(ids).toEqual(['homeassistant.values']);
	});

	it('offers nothing when no permission is ticked', () => {
		expect(addablePages(contributions, [], [], [])).toEqual([]);
	});
});

describe('listedPages', () => {
	it('keeps the order and drops pages whose permission was unticked or that no longer exist', () => {
		const ids = listedPages(
			contributions,
			['calendar.view', 'homeassistant.view'],
			['homeassistant.values', 'board.notes', 'gone.page', 'calendar.week'],
			[],
		).map((c) => c.id);
		expect(ids).toEqual(['homeassistant.values', 'calendar.week']);
	});

	it('drops a page of an extension that was turned off', () => {
		const ids = listedPages(contributions, ['calendar.view'], ['calendar.week'], ['calendar']);
		expect(ids).toEqual([]);
	});
});

describe('withCurrent', () => {
	it('shows a value that is not among the choices, in its place', () => {
		expect(withCurrent([30, 60, 120], 90)).toEqual([30, 60, 90, 120]);
		expect(withCurrent([30, 60, 120], 60)).toEqual([30, 60, 120]);
		expect(withCurrent([30, 60, 120], 3600)).toEqual([30, 60, 120, 3600]);
	});
});

describe('movePage', () => {
	it('moves a page up or down by one', () => {
		expect(movePage(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
		expect(movePage(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
	});

	it('leaves the list as it is at the ends', () => {
		expect(movePage(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
		expect(movePage(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
	});
});

describe('rotationToSave', () => {
	const durations = { todaySeconds: 30, pageSeconds: 10, backSeconds: 60 };
	it('saves nothing when no page is chosen', () => {
		expect(rotationToSave({ pages: [], ...durations })).toBeNull();
	});
	it('saves the pages and the durations', () => {
		const choice = { pages: ['a.b'], ...durations };
		expect(rotationToSave(choice)).toEqual(choice);
	});
});

describe('pagesChanged', () => {
	const base = { pages: ['a.b', 'c.d'], todaySeconds: 30, pageSeconds: 10, backSeconds: 60 };
	it('sees a change of order, pages or any duration', () => {
		expect(pagesChanged(base, { ...base })).toBe(false);
		expect(pagesChanged(base, { ...base, pages: ['c.d', 'a.b'] })).toBe(true);
		expect(pagesChanged(base, { ...base, pages: ['a.b'] })).toBe(true);
		expect(pagesChanged(base, { ...base, pageSeconds: 20 })).toBe(true);
		expect(pagesChanged(base, { ...base, backSeconds: 120 })).toBe(true);
		expect(pagesChanged(base, { ...base, todaySeconds: 60 })).toBe(true);
	});
});
