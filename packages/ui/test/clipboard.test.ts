import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from '../src/clipboard.ts';

const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
	if (original) Object.defineProperty(navigator, 'clipboard', original);
	else Reflect.deleteProperty(navigator, 'clipboard');
	vi.restoreAllMocks();
});

function noClipboard() {
	Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
}

describe('copyText', () => {
	it('uses the clipboard when there is one', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		expect(await copyText('abc')).toBe(true);
		expect(writeText).toHaveBeenCalledWith('abc');
	});

	it('falls back to selecting text and copying on a page without a clipboard', async () => {
		noClipboard();
		let copied = '';
		document.execCommand = vi.fn(() => {
			copied = (document.querySelector('textarea') as HTMLTextAreaElement).value;
			return true;
		});
		expect(await copyText('abc')).toBe(true);
		expect(copied).toBe('abc');
		expect(document.querySelector('textarea')).toBeNull();
	});

	it('says so when nothing can copy', async () => {
		noClipboard();
		document.execCommand = vi.fn(() => false);
		expect(await copyText('abc')).toBe(false);
		expect(document.querySelector('textarea')).toBeNull();
	});
});
