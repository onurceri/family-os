import { flushSync } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { RepeatPicker } from '../src/famos/index.js';
import { box } from './box.svelte.js';
import { cleanup, click, qa, render } from './helpers.js';

afterEach(cleanup);

const days = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].map((code) => ({ code, label: code }));
const labels = {
	none: 'None',
	daily: 'Daily',
	weekly: 'Weekly',
	monthly: 'Monthly',
	custom: 'Custom',
	until: 'Until',
};
const setup = (byDay: string[], startDate: string) =>
	box({
		preset: 'weekly' as const,
		byDay,
		until: '',
		days,
		labels,
		idPrefix: 'rp',
		startDate,
	});
const pressed = (el: HTMLElement) =>
	qa('#rp-days button', el)
		.filter((b) => b.getAttribute('aria-pressed') === 'true')
		.map((b) => b.textContent?.trim());

describe('RepeatPicker start date', () => {
	// 2026-10-18 is a Sunday, 2026-10-20 a Tuesday, 2026-10-22 a Thursday.
	it('moves the weekly day with the start date', () => {
		const props = setup(['SU'], '2026-10-18');
		const el = render(RepeatPicker, props);
		expect(pressed(el)).toEqual(['SU']);
		props.startDate = '2026-10-20';
		flushSync();
		expect(props.byDay).toEqual(['TU']);
	});

	it('keeps chosen days and adds the new date weekday', () => {
		const props = setup(['SU'], '2026-10-18');
		const el = render(RepeatPicker, props);
		click(qa('#rp-days button', el)[3] as HTMLElement);
		expect(props.byDay).toEqual(['TH', 'SU']);
		props.startDate = '2026-10-20';
		flushSync();
		expect(props.byDay).toEqual(['TU', 'TH', 'SU']);
	});

	it('does nothing when it first shows a saved rule', () => {
		const props = setup(['MO', 'WE'], '2026-10-20');
		render(RepeatPicker, props);
		expect(props.byDay).toEqual(['MO', 'WE']);
	});
});
