import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileTargetChoices } from '../src/famos/index.js';
import Icon from './fixtures/IconProbe.svelte';
import { cleanup, click, q, qa, render } from './helpers.js';

afterEach(cleanup);

const choices = [
	{ recordId: 'pet_1', recordKind: 'pet', name: 'Luna', icon: Icon },
	{ recordId: 'pet_2', recordKind: 'pet', name: 'Max', icon: Icon },
];

describe('FileTargetChoices', () => {
	it('shows nothing without choices', () => {
		const el = render(FileTargetChoices, {
			title: 'Add to',
			choices: [],
			selected: null,
			onselect: vi.fn(),
		});
		expect(q('[role=group]', el)).toBeNull();
	});

	it('picks a record, and picking the chosen one again clears it', () => {
		const onselect = vi.fn();
		const el = render(FileTargetChoices, {
			title: 'Add to',
			choices,
			selected: { recordId: 'pet_2' },
			onselect,
		});
		expect(q('[role=group]', el).getAttribute('aria-label')).toBe('Add to');
		const buttons = qa('button', el);
		expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
		click(buttons[0] as HTMLElement);
		expect(onselect).toHaveBeenLastCalledWith({
			recordId: 'pet_1',
			recordKind: 'pet',
			name: 'Luna',
		});
		click(buttons[1] as HTMLElement);
		expect(onselect).toHaveBeenLastCalledWith(null);
	});
});
