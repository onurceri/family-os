import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmButton, ListDetail, SettingRow, SidePanel, Tile } from '../src/famos/index.js';
import { box } from './box.svelte.js';
import { cleanup, click, html, key, q, qa, render, settle } from './helpers.js';
import { wide } from './wide-mock.svelte.js';

vi.mock('../src/famos/wide.svelte.js', () => import('./wide-mock.svelte.js'));

beforeEach(() => {
	wide.current = true;
});
afterEach(cleanup);

const discard = {
	title: 'Discard?',
	description: 'Not saved.',
	keep: 'Keep editing',
	discard: 'Discard',
};
const buttonByText = (text: string) =>
	qa('button').find((b) => b.textContent?.trim() === text) as HTMLElement;

function panel(props: Record<string, unknown> = {}) {
	return render(SidePanel, {
		open: true,
		title: 'Vehicle',
		closeLabel: 'Cancel',
		onclose: vi.fn(),
		children: html('<input id="f" /><p>body</p>'),
		...props,
	});
}

describe('Tile', () => {
	it('is lit by default, idle on request, and marks the selected one', () => {
		let el = render(Tile, { title: 'Clio', subtitle: 'Petrol', href: '/v/1' });
		const a = q('a.tile', el);
		expect(a.classList.contains('idle')).toBe(false);
		expect(a.classList.contains('two')).toBe(true);
		expect(a.getAttribute('aria-current')).toBeNull();
		cleanup();
		el = render(Tile, { title: 'Clio', href: '/v/1', selected: true, idle: true });
		const sel = q('a.tile', el);
		expect(sel.classList.contains('selected')).toBe(true);
		expect(sel.classList.contains('idle')).toBe(true);
		expect(sel.getAttribute('aria-current')).toBe('page');
	});

	it('recedes with idle and strikes a done title', () => {
		const el = render(Tile, { title: 'Done', idle: true, done: true });
		expect(q('.tile', el).classList.contains('idle')).toBe(true);
		expect(q('.title', el).classList.contains('done')).toBe(true);
	});

	it('is a button when it has onclick', () => {
		const spy = vi.fn();
		const el = render(Tile, { title: 'Open', onclick: spy });
		click(q('button.tile', el));
		expect(spy).toHaveBeenCalledOnce();
	});
});

describe('ConfirmButton', () => {
	it('arms on the first tap, confirms on the second, in the danger look', () => {
		const spy = vi.fn();
		const el = render(ConfirmButton, { label: 'Delete', confirmLabel: 'Sure?', onconfirm: spy });
		const b = q('button', el);
		expect(b.className).toContain('text-destructive');
		click(b);
		expect(b.textContent?.trim()).toBe('Sure?');
		expect(b.className).toContain('bg-destructive');
		expect(spy).not.toHaveBeenCalled();
		click(b);
		expect(spy).toHaveBeenCalledOnce();
	});
});

describe('ConfirmButton name', () => {
	it('is told apart from its twins until armed, then says its confirmation', () => {
		const el = render(ConfirmButton, {
			label: 'Dismiss all',
			confirmLabel: 'Tap again',
			name: 'Dismiss all from Piano recital',
			onconfirm: vi.fn(),
		});
		const b = q('button', el);
		expect(b.getAttribute('aria-label')).toBe('Dismiss all from Piano recital');
		click(b);
		expect(b.getAttribute('aria-label')).toBe('Tap again');
	});

	it('has no label of its own when it is not given a name', () => {
		const el = render(ConfirmButton, {
			label: 'Delete',
			confirmLabel: 'Sure?',
			onconfirm: vi.fn(),
		});
		expect(q('button', el).hasAttribute('aria-label')).toBe(false);
	});
});

describe('SettingRow', () => {
	it('stacks by default and keeps a small control beside the label when inline', () => {
		const control = html('<input />');
		let el = render(SettingRow, { label: 'Zone', control });
		expect(q('.grid', el).className).not.toContain('grid-cols-[minmax(0,1fr)_auto]');
		expect(q('.grid', el).className).toContain('@lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]');
		cleanup();
		el = render(SettingRow, { label: 'Zone', inline: true, control });
		expect(q('.grid', el).className).toContain('grid-cols-[minmax(0,1fr)_auto]');
	});
});

describe('SidePanel on a wide window', () => {
	it('is a panel with a header, a body and a Save, Cancel and danger footer', () => {
		const onsave = vi.fn();
		const el = panel({
			saveLabel: 'Save',
			onsave,
			danger: html('<button>Archive</button>'),
		});
		const dialog = q('[data-testid=side-panel]', el.ownerDocument);
		expect(dialog.getAttribute('aria-modal')).toBe('false');
		expect(q('h2', dialog).textContent).toBe('Vehicle');
		const footer = q('[data-testid=side-panel-footer]', dialog);
		expect(footer.textContent).toContain('Save');
		expect(footer.textContent).toContain('Cancel');
		expect(footer.textContent).toContain('Archive');
		click(buttonByText('Save'));
		expect(onsave).toHaveBeenCalledOnce();
	});

	it('has no footer without a Save (a details view)', () => {
		panel();
		expect(q('[data-testid=side-panel-footer]')).toBeNull();
	});

	it('says under the title when saving only suggests the change, on a panel and a sheet', () => {
		panel();
		expect(q('[data-testid=side-panel-note]')).toBeNull();
		cleanup();
		const note = 'After you save, someone has to approve this.';
		const approval = { note, saveLabel: 'Send for approval' };
		panel({ approval, saveLabel: 'Save', onsave: vi.fn() });
		expect(q('[data-testid=side-panel-note]')?.textContent).toContain(note);
		expect(document.body.textContent).toContain('Send for approval');
		expect(document.body.textContent).not.toMatch(/\bSave\b/);
		cleanup();
		wide.current = false;
		panel({ approval, saveLabel: 'Save', onsave: vi.fn() });
		expect(q('[data-testid=side-panel-note]')?.textContent).toContain(note);
		expect(document.body.textContent).toContain('Send for approval');
	});

	it('saves with Ctrl+Enter and closes with Escape', () => {
		const onsave = vi.fn();
		const onclose = vi.fn();
		panel({ saveLabel: 'Save', onsave, onclose });
		key(document.body, 'Enter', { ctrlKey: true });
		expect(onsave).toHaveBeenCalledOnce();
		key(document.body, 'Escape');
		expect(onclose).toHaveBeenCalledOnce();
	});

	it('closes straight away when nothing changed', () => {
		const onclose = vi.fn();
		panel({ onclose, dirty: false, discard });
		click(q('button[aria-label=Cancel]'));
		expect(onclose).toHaveBeenCalledOnce();
	});

	it('asks before closing when dirty, and only closes on Discard', async () => {
		const onclose = vi.fn();
		panel({ onclose, dirty: true, discard });
		key(document.body, 'Escape');
		await settle();
		expect(onclose).not.toHaveBeenCalled();
		const dialog = q('dialog');
		expect(dialog.textContent).toContain('Discard?');
		click(buttonByText('Keep editing'));
		expect(onclose).not.toHaveBeenCalled();
		key(document.body, 'Escape');
		await settle();
		click(buttonByText('Discard'));
		expect(onclose).toHaveBeenCalledOnce();
	});

	it('lets beforeclose veto the close', async () => {
		const onclose = vi.fn();
		const beforeclose = vi.fn(() => false);
		panel({ onclose, beforeclose });
		click(q('button[aria-label=Cancel]'));
		await settle();
		expect(beforeclose).toHaveBeenCalledOnce();
		expect(onclose).not.toHaveBeenCalled();
	});

	it('opens closeHref through the router after closing (the ?edit= address goes away)', async () => {
		const links: string[] = [];
		document.addEventListener(
			'click',
			(e) => {
				const a = (e.target as HTMLElement).closest('a');
				if (a) {
					links.push(a.getAttribute('href') ?? '');
					e.preventDefault();
				}
			},
			{ once: true },
		);
		const onclose = vi.fn();
		panel({ onclose, closeHref: '/vehicles' });
		click(q('button[aria-label=Cancel]'));
		await settle();
		expect(onclose).toHaveBeenCalledOnce();
		expect(links).toEqual(['/vehicles']);
	});
});

describe('SidePanel that reads first (a change that waits for approval)', () => {
	const approval = { note: 'Someone has to approve this.', saveLabel: 'Send for approval' };
	const readFirst = { details: html('<p>Piano lesson details</p>'), label: 'Suggest a change' };

	it('opens on the details with one "Suggest a change", and the form only on it', async () => {
		const onsave = vi.fn();
		panel({ approval, saveLabel: 'Save', onsave, readFirst });
		expect(document.body.textContent).toContain('Piano lesson details');
		expect(q('#f')).toBeNull();
		expect(q('[data-testid=side-panel-note]')).toBeNull();
		expect(document.body.textContent).not.toContain('Send for approval');
		key(document.body, 'Enter', { ctrlKey: true });
		expect(onsave).not.toHaveBeenCalled();
		click(buttonByText('Suggest a change'));
		await settle();
		expect(q('#f')).toBeTruthy();
		expect(document.activeElement).toBe(q('#f'));
		expect(q('[data-testid=side-panel-note]')?.textContent).toContain('approve');
		click(buttonByText('Send for approval'));
		expect(onsave).toHaveBeenCalledOnce();
	});

	it('does the same in the phone sheet', () => {
		wide.current = false;
		panel({ approval, saveLabel: 'Save', onsave: vi.fn(), readFirst });
		expect(document.body.textContent).toContain('Piano lesson details');
		expect(document.body.textContent).not.toContain('Send for approval');
		click(buttonByText('Suggest a change'));
		expect(q('#f')).toBeTruthy();
		expect(document.body.textContent).toContain('Send for approval');
	});

	it('opens on the details again when it opens again or shows another thing', () => {
		const props = box({
			open: true,
			title: 'Event',
			closeLabel: 'Close',
			onclose: vi.fn(),
			saveLabel: 'Save',
			onsave: vi.fn(),
			children: html('<input id="f" />'),
			readFirst: { ...readFirst, key: 'a' } as typeof readFirst & { key: string },
		});
		render(SidePanel, props);
		click(buttonByText('Suggest a change'));
		expect(q('#f')).toBeTruthy();
		// The page draws the same thing again: the form stays.
		props.readFirst = { ...readFirst, key: 'a' };
		flushSync();
		expect(q('#f')).toBeTruthy();
		props.readFirst = { ...readFirst, key: 'b' };
		flushSync();
		expect(q('#f')).toBeNull();
		click(buttonByText('Suggest a change'));
		props.open = false;
		flushSync();
		props.open = true;
		flushSync();
		expect(q('#f')).toBeNull();
		expect(document.body.textContent).toContain('Piano lesson details');
	});

	it('is the plain form for someone who changes directly', () => {
		panel({ saveLabel: 'Save', onsave: vi.fn() });
		expect(q('#f')).toBeTruthy();
		expect(qa('button').some((b) => b.textContent?.includes('Suggest a change'))).toBe(false);
	});
});

describe('SidePanel below 1024 px', () => {
	it('is a sheet with Cancel, the title and Save, and the danger action at the end', () => {
		wide.current = false;
		const onsave = vi.fn();
		const onclose = vi.fn();
		panel({
			saveLabel: 'Save',
			onsave,
			onclose,
			danger: html('<button>Archive</button>'),
		});
		expect(q('[data-testid=side-panel-footer]')).toBeNull();
		const sheet = q('[role=dialog][aria-modal=true]');
		expect(sheet).toBeTruthy();
		const bar = q('header', sheet);
		expect(bar.textContent).toContain('Cancel');
		expect(bar.textContent).toContain('Vehicle');
		expect(bar.textContent).toContain('Save');
		expect(sheet.textContent).toContain('Archive');
		click(buttonByText('Save'));
		expect(onsave).toHaveBeenCalledOnce();
	});

	it('asks about unsaved changes from the sheet too', async () => {
		wide.current = false;
		const onclose = vi.fn();
		panel({ onclose, dirty: true, discard, saveLabel: 'Save', onsave: vi.fn() });
		click(buttonByText('Cancel'));
		await settle();
		expect(onclose).not.toHaveBeenCalled();
		expect(q('dialog').textContent).toContain('Discard?');
		click(buttonByText('Discard'));
		expect(onclose).toHaveBeenCalledOnce();
	});

	it('switches between panel and sheet when the window crosses 1024 px', () => {
		const props = box({ saveLabel: 'Save', onsave: vi.fn() });
		panel(props);
		expect(q('[data-testid=side-panel-footer]')).toBeTruthy();
		wide.current = false;
		flushSync();
		expect(q('[data-testid=side-panel-footer]')).toBeNull();
		expect(q('[aria-modal=true]')).toBeTruthy();
	});
});

describe('ListDetail', () => {
	const props = (extra: Record<string, unknown> = {}) => ({
		title: 'Vehicles',
		selected: true,
		list: html('<ul><li>Clio</li></ul>'),
		detail: html('<p id="detail">detail</p>'),
		...extra,
	});

	it('shows the list column and the detail side by side with two or more items', () => {
		const el = render(ListDetail, props({ count: 2 }));
		expect(q('#detail', el)).toBeTruthy();
		expect(q('ul', el)).toBeTruthy();
		expect(q('[data-testid=single-item]', el)).toBeNull();
		expect(q('.grid-cols-\\[260px_minmax\\(0\\,1fr\\)\\]', el)).toBeTruthy();
	});

	it('shows the item alone when there is exactly one (the item is the page)', () => {
		const el = render(ListDetail, props({ count: 1 }));
		expect(q('[data-testid=single-item] #detail', el)).toBeTruthy();
		expect(q('.grid-cols-\\[260px_minmax\\(0\\,1fr\\)\\]', el)).toBeNull();
		// The list stays mounted (it keeps loading) but is collapsed.
		expect(q('.collapsed', el)).toBeTruthy();
	});

	it('opens the first item by itself on a wide window with nothing chosen', async () => {
		const links: string[] = [];
		document.addEventListener('click', (e) => {
			const a = (e.target as HTMLElement).closest('a');
			if (a) {
				links.push(a.getAttribute('href') ?? '');
				e.preventDefault();
			}
		});
		render(ListDetail, props({ selected: false, first: '/vehicles/v1', count: 1 }));
		await settle();
		expect(links).toContain('/vehicles/v1');
	});

	it('shows only the list below 1024 px until an item is chosen', () => {
		wide.current = false;
		let el = render(ListDetail, props({ selected: false, count: 1 }));
		expect(q('ul', el)).toBeTruthy();
		expect(q('#detail', el)).toBeNull();
		cleanup();
		el = render(ListDetail, props({ selected: true, count: 1 }));
		expect(q('#detail', el)).toBeTruthy();
		expect(q('ul', el)).toBeNull();
	});
});
