import { afterEach, describe, expect, it } from 'vitest';
import { MemberChips } from '../src/famos/index.js';
import { box } from './box.svelte.js';
import { cleanup, click, qa, render } from './helpers.js';

afterEach(cleanup);

const members = [
	{ id: 'mara', displayName: 'Mara', color: 'var(--m1)' },
	{ id: 'tom', displayName: 'Tom', color: 'var(--m2)' },
];
const chips = (el: HTMLElement) => qa('button', el);
/** A chip's words without the avatar's initial. */
const text = (b: HTMLElement) => b.textContent?.trim().replace(/^\S\s+(?=\S)/, '');
const names = (el: HTMLElement) => chips(el).map(text);
const pressed = (el: HTMLElement) =>
	chips(el)
		.filter((b) => b.getAttribute('aria-pressed') === 'true')
		.map(text);

describe('MemberChips', () => {
	it('makes nobody a visible choice for any number of people', () => {
		const props = box({
			members,
			selected: [] as string[],
			multiple: true,
			noneLabel: 'Whole family',
		});
		const el = render(MemberChips, props);
		expect(names(el)).toEqual(['Whole family', 'Mara', 'Tom']);
		expect(pressed(el)).toEqual(['Whole family']);

		click(chips(el)[1] as HTMLElement);
		click(chips(el)[2] as HTMLElement);
		expect(props.selected).toEqual(['mara', 'tom']);
		expect(pressed(el)).toEqual(['Mara', 'Tom']);

		click(chips(el)[0] as HTMLElement);
		expect(props.selected).toEqual([]);
		expect(pressed(el)).toEqual(['Whole family']);
	});

	it('shows no such chip without a label', () => {
		const el = render(MemberChips, { members, selected: [], multiple: true });
		expect(names(el)).toEqual(['Mara', 'Tom']);
	});
});
