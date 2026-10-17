import { afterEach, describe, expect, it, vi } from 'vitest';
import catalog from '../../../apps/web/src/messages/en.json';
import {
	FIELD_REASON,
	FieldError,
	fieldAria,
	focusFirstInvalid,
	issueErrors,
	SwitchRow,
} from '../src/famos/index.js';
import { cleanup, click, q, render, settle } from './helpers.js';

afterEach(cleanup);

const appCatalog: Record<string, string> = catalog;

describe('field errors', () => {
	it('names only reasons the app catalog has', () => {
		for (const key of Object.values(FIELD_REASON)) {
			const [ns, name] = key.split(':');
			expect(ns).toBe('app');
			expect(appCatalog[name as string], key).toBeTruthy();
		}
	});

	it('gives each failing schema field one reason, keeping the form’s own first', () => {
		const errors = issueErrors(
			{ title: 'calendar:own' },
			[
				{ path: ['title'], code: 'too_small' },
				{ path: ['notes'], code: 'too_big' },
				{ path: ['notes'], code: 'custom' },
				{ path: ['endTime'], code: 'custom' },
				{ path: ['reminder'], code: 'custom' },
				{ path: [], code: 'custom' },
			],
			{ endTime: 'calendar:error_end_same' },
		);
		expect(errors).toEqual({
			title: 'calendar:own',
			notes: FIELD_REASON.tooLong,
			endTime: 'calendar:error_end_same',
			reminder: FIELD_REASON.check,
			form: FIELD_REASON.check,
		});
	});

	it('links a refused field to its reason', () => {
		expect(fieldAria(undefined, 'x')).toEqual({
			'aria-invalid': undefined,
			'aria-describedby': undefined,
		});
		expect(fieldAria(FIELD_REASON.name, 'x')).toEqual({
			'aria-invalid': 'true',
			'aria-describedby': 'x-error',
		});
	});

	it('shows the reason under the field, and nothing when it is fine', () => {
		let el = render(FieldError, { for: 'pet-name' });
		expect(el.textContent?.trim()).toBe('');
		cleanup();
		el = render(FieldError, { for: 'pet-name', error: 'Give it a name' });
		const p = q('#pet-name-error', el);
		expect(p.textContent?.trim()).toBe('Give it a name');
		expect(p.className).toContain('text-attention');
	});

	it('moves focus to the first refused field, or the first control of a refused group', async () => {
		const form = document.createElement('form');
		form.innerHTML = `
			<input id="ok" />
			<div id="days" role="group" aria-invalid="true"><button id="mo" type="button">Mo</button></div>
			<input id="title" aria-invalid="true" />`;
		document.body.append(form);
		await focusFirstInvalid(form);
		await settle();
		expect(document.activeElement?.id).toBe('mo');
		form.querySelector('#days')?.removeAttribute('aria-invalid');
		await focusFirstInvalid(form);
		expect(document.activeElement?.id).toBe('title');
	});
});

describe('SwitchRow with onopen', () => {
	it('opens from its text and toggles only from the switch', () => {
		const opened = vi.fn();
		const changed = vi.fn();
		const el = render(SwitchRow, {
			id: 'extension-lists',
			label: 'Lists',
			hint: 'Tasks and shopping',
			checked: true,
			onopen: opened,
			onchange: changed,
		});
		const input = q<HTMLInputElement>('input[role="switch"]', el);
		click(q('[data-testid="extension-lists-open"]', el));
		expect(opened).toHaveBeenCalledOnce();
		expect(input.checked).toBe(true);
		expect(changed).not.toHaveBeenCalled();
		expect(input.getAttribute('aria-label')).toBe('Lists');
		click(input);
		expect(changed).toHaveBeenCalledWith(false);
	});
});
