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
const setup = (byDay: string[], startDate: string, saved = false) =>
	box({
		preset: 'weekly' as const,
		byDay,
		until: '',
		days,
		labels: { ...labels, firstTime: (date: string) => `First time: ${date}` },
		idPrefix: 'rp',
		startDate,
		saved,
		dateLocale: 'en-GB',
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

describe('RepeatPicker for a saved item', () => {
	it('keeps its days when the start date moves', () => {
		const props = setup(['TU'], '2026-10-18', true);
		const el = render(RepeatPicker, props);
		props.startDate = '2026-10-21';
		flushSync();
		expect(props.byDay).toEqual(['TU']);
		expect(pressed(el)).toEqual(['TU']);
		expect(el.querySelector('[data-testid="repeat-first-time"]')?.textContent?.trim()).toMatch(
			/^First time: Tuesday,? 27 October$/,
		);
	});

	it('says the first time follows the new date for a new item too', () => {
		const props = setup(['TU'], '2026-10-20');
		const el = render(RepeatPicker, props);
		expect(el.querySelector('[data-testid="repeat-first-time"]')?.textContent).toContain(
			'20 October',
		);
	});

	it('has no line when no day is chosen', () => {
		const el = render(RepeatPicker, setup([], '2026-10-20', true));
		expect(el.querySelector('[data-testid="repeat-first-time"]')).toBeNull();
	});
});
