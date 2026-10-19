import { afterEach, describe, expect, it } from 'vitest';
import { RepeatScope } from '../src/famos/index.js';
import { box } from './box.svelte.js';
import { cleanup, click, q, render } from './helpers.js';

afterEach(cleanup);

const words = {
	title: 'Which ones should change?',
	only: { label: 'Only this one', hint: 'Moves to Wednesday.' },
	following: { label: 'This one and the ones after', hint: 'Next: Tuesday.' },
	cancel: 'Cancel',
};

describe('RepeatScope', () => {
	it('offers both choices with what each does, and reports the one picked', () => {
		const picked: string[] = [];
		const props = box({
			open: true,
			words,
			onpick: (c: string) => picked.push(c),
			onclose: () => {},
		});
		const el = render(RepeatScope, props);
		expect(el.textContent).toContain('Moves to Wednesday.');
		expect(el.textContent).toContain('Next: Tuesday.');
		click(q('[data-testid="repeat-scope-following"]', el) as HTMLElement);
		click(q('[data-testid="repeat-scope-this"]', el) as HTMLElement);
		expect(picked).toEqual(['following', 'this']);
	});

	it('shows nothing while closed', () => {
		const el = render(
			RepeatScope,
			box({ open: false, words, onpick: () => {}, onclose: () => {} }),
		);
		expect(el.textContent?.trim()).toBe('');
	});
});
