import { describe, expect, it } from 'vitest';
import { displayOptions, initialGrant } from './display-options.js';

describe('displayOptions', () => {
	const contributions = [
		{ slot: 'display.widget', requires: 'weather.view' },
		{ slot: 'display.status', requires: 'core.drafts.waiting' },
		{ slot: 'display.ambient', requires: 'photos.view' },
		{ slot: 'dashboard.card', requires: 'vehicles.view' },
		{ slot: 'display.widget' },
	];

	it('offers what the day, a widget, a status pill or ambient mode needs, nothing else', () => {
		const { offered } = displayOptions(['calendar.view', 'chores.view'], contributions);
		expect([...offered].sort()).toEqual([
			'calendar.view',
			'chores.view',
			'core.drafts.waiting',
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
