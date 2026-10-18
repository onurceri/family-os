import { describe, expect, it } from 'vitest';
import {
	displayOptions,
	initialGrant,
	leftOutNames,
	needingNames,
	wastedWithoutNames,
} from './display-options.js';

describe('displayOptions', () => {
	const contributions = [
		{ slot: 'display.widget', requires: 'weather.view' },
		{ slot: 'display.status', requires: 'core.drafts.waiting' },
		{ slot: 'display.ambient', requires: 'photos.view' },
		{ slot: 'display.page', requires: 'homeassistant.view' },
		{ slot: 'dashboard.card', requires: 'vehicles.view' },
		{ slot: 'display.widget' },
	];

	it('offers what the day, a widget, a page, a status pill or ambient mode needs, nothing else', () => {
		const { offered } = displayOptions(['calendar.view', 'chores.view'], contributions);
		expect([...offered].sort()).toEqual([
			'calendar.view',
			'chores.view',
			'core.drafts.waiting',
			'homeassistant.view',
			'photos.view',
			'weather.view',
		]);
	});

	it('leaves a permission only a status pill needs unticked on a new screen', () => {
		const { optIn } = displayOptions(['calendar.view'], contributions);
		expect([...optIn]).toEqual(['core.drafts.waiting']);
		const options = [{ id: 'calendar.view' }, { id: 'core.drafts.waiting' }, { id: 'photos.view' }];
		expect(initialGrant(options, optIn)).toEqual(['calendar.view', 'photos.view']);
	});

	it('ticks a pill’s permission when the day needs it too', () => {
		const { optIn } = displayOptions(['core.drafts.waiting'], contributions);
		expect(optIn.size).toBe(0);
	});
});

describe('leftOutNames', () => {
	const contributions = [
		{ slot: 'display.widget', id: 'homeassistant.values', labelKey: 'homeassistant:today_block' },
		{ slot: 'dashboard.card', id: 'lists.tasks', labelKey: 'lists:today_block_tasks' },
		{ slot: 'display.widget', id: 'lists.tasks' },
	];

	it('names groups by their words and widgets by their own name, in the order given', () => {
		expect(
			leftOutNames(
				['homeassistant.values', 'family', 'extras', 'lists.tasks', 'gone.widget'],
				contributions,
			),
		).toEqual([
			{ id: 'homeassistant.values', labelKey: 'homeassistant:today_block' },
			{ key: 'devices_left_out_family' },
			{ key: 'devices_left_out_extras' },
			// A widget without a name of its own, or no longer installed, is named by its id.
			{ id: 'lists.tasks' },
			{ id: 'gone.widget' },
		]);
		expect(leftOutNames([], contributions)).toEqual([]);
	});
});

describe('needing names', () => {
	const facets = [
		{ kind: 'memberStatus', requires: 'homeassistant.presence' },
		{ kind: 'photo', requires: 'ambient.photos' },
		{ kind: 'memberStatus' },
	];

	it('lists the permissions of facets that say a word about each person', () => {
		expect([...needingNames(facets)]).toEqual(['homeassistant.presence']);
	});

	it('flags a ticked one only while names are off', () => {
		const needing = needingNames(facets);
		const ticked = ['calendar.view', 'homeassistant.presence'];
		expect(wastedWithoutNames(ticked, needing, false)).toEqual(['homeassistant.presence']);
		expect(wastedWithoutNames(ticked, needing, true)).toEqual([]);
		expect(wastedWithoutNames(['calendar.view'], needing, false)).toEqual([]);
	});
});
