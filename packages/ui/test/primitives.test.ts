import { createRawSnippet, flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ActionSheet,
	Card,
	Chip,
	Composer,
	Dialog,
	EMPTY_ART_NAMES,
	EmptyLine,
	EmptyState,
	Fab,
	Facts,
	IconButton,
	Menu,
	type MenuItem,
	Notice,
	Pill,
	RecordHeader,
	Row,
	Section,
	Segmented,
	Sheet,
} from '../src/famos/index.js';
import { box } from './box.svelte.js';
import { cleanup, click, html, key, q, qa, render, settle } from './helpers.js';

afterEach(cleanup);

const items = (spy = vi.fn()): MenuItem[] => [
	{ id: 'edit', label: 'Edit', kbd: 'e', onselect: () => spy('edit') },
	{ id: 'archive', label: 'Archive', onselect: () => spy('archive') },
	{ id: 'delete', label: 'Delete', danger: true, onselect: () => spy('delete') },
];

/** A trigger button that opens the menu through the attributes the Menu hands out. */
const trigger = createRawSnippet(
	(a: () => { attrs: { onclick: () => void; 'aria-controls': string } }) => ({
		render: () => '<button id="opener" type="button">Options</button>',
		setup(el: Element) {
			const attrs = a().attrs;
			el.setAttribute('aria-haspopup', 'menu');
			el.addEventListener('click', () => a().attrs.onclick());
			void attrs;
		},
	}),
);

describe('Card', () => {
	it('is a plain card by default and takes variants', () => {
		const el = render(Card, { children: html('<i>x</i>') });
		expect(q('.card', el).classList.contains('plain')).toBe(true);
		cleanup();
		const lit = render(Card, { variant: 'lit', rows: true, pad: true, children: html('<i>x</i>') });
		const card = q('.card', lit);
		expect(card.classList.contains('lit')).toBe(true);
		expect(card.classList.contains('rows')).toBe(true);
		expect(card.classList.contains('pad')).toBe(true);
	});
});

describe('Row', () => {
	it('renders a div, a link or a button and a meta line makes it two lines', () => {
		let el = render(Row, { title: 'Clio' });
		expect(q('div.row', el)).toBeTruthy();
		cleanup();
		el = render(Row, { title: 'Clio', meta: 'Petrol', href: '/v/1', selected: true });
		const a = q('a.row', el);
		expect(a.getAttribute('href')).toBe('/v/1');
		expect(a.getAttribute('aria-current')).toBe('page');
		expect(a.classList.contains('two')).toBe(true);
		cleanup();
		const spy = vi.fn();
		el = render(Row, { title: 'Clio', onclick: spy, done: true, tile: true });
		click(q('button.row', el));
		expect(spy).toHaveBeenCalledOnce();
		expect(q('.title', el).classList.contains('done')).toBe(true);
		expect(q('.row', el).classList.contains('tile')).toBe(true);
	});
});

describe('Section', () => {
	it('labels its region with a heading, a plain count and actions', () => {
		const el = render(Section, {
			label: 'Needs doing',
			count: 2,
			actions: html('<button>Add</button>'),
			children: html('<p>content</p>'),
		});
		const region = q('section', el);
		const heading = q('h2', el);
		expect(heading.textContent).toBe('Needs doing');
		expect(region.getAttribute('aria-labelledby')).toBe(heading.id);
		expect(q('.count', el).textContent).toBe('2');
		expect(q('.actions button', el).textContent).toBe('Add');
	});
});

describe('Segmented', () => {
	const options = [
		{ value: 'a', label: 'Week' },
		{ value: 'b', label: 'Month' },
		{ value: 'c', label: 'Year' },
	];

	it('is a radiogroup with one tab stop on the chosen option', () => {
		const el = render(Segmented, { options, value: 'b', label: 'View' });
		const group = q('[role=radiogroup]', el);
		expect(group.getAttribute('aria-label')).toBe('View');
		const radios = qa('[role=radio]', el);
		expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
		expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
	});

	it('moves and chooses with arrow keys, wrapping, and Home/End', () => {
		const onchange = vi.fn();
		const el = render(Segmented, { options, value: 'a', label: 'View', onchange });
		const radios = qa('[role=radio]', el);
		(radios[0] as HTMLElement).focus();
		key(radios[0] as HTMLElement, 'ArrowRight');
		expect(onchange).toHaveBeenLastCalledWith('b');
		expect(document.activeElement).toBe(radios[1]);
		key(radios[1] as HTMLElement, 'End');
		expect(onchange).toHaveBeenLastCalledWith('c');
		key(radios[2] as HTMLElement, 'ArrowRight');
		expect(onchange).toHaveBeenLastCalledWith('a');
		key(radios[0] as HTMLElement, 'ArrowLeft');
		expect(onchange).toHaveBeenLastCalledWith('c');
		expect(radios[2]?.getAttribute('aria-checked')).toBe('true');
	});

	it('chooses on click and can grow or be small', () => {
		const onchange = vi.fn();
		const el = render(Segmented, { options, label: 'View', size: 'sm', grow: true, onchange });
		click(qa('[role=radio]', el)[2] as HTMLElement);
		expect(onchange).toHaveBeenCalledWith('c');
		expect(q('.seg', el).classList.contains('sm')).toBe(true);
		expect(q('.seg', el).classList.contains('grow')).toBe(true);
	});
});

describe('Chip', () => {
	it('toggles (aria-pressed) for filter and member, not for preset', () => {
		const el = render(Chip, { on: true, count: 4, children: html('Groceries') });
		const chip = q('button', el);
		expect(chip.getAttribute('aria-pressed')).toBe('true');
		expect(chip.classList.contains('on')).toBe(true);
		expect(q('.n', el).textContent).toBe('4');
		cleanup();
		const member = render(Chip, {
			variant: 'member',
			on: true,
			color: '#123456',
			lead: html('<i>A</i>'),
			children: html('Amy'),
		});
		expect(q('button', member).style.getPropertyValue('--m')).toBe('#123456');
		cleanup();
		const preset = render(Chip, { variant: 'preset', children: html('Service') });
		expect(q('button', preset).hasAttribute('aria-pressed')).toBe(false);
	});
});

describe('Pill', () => {
	it('renders the tone class and an icon', () => {
		const el = render(Pill, {
			tone: 'attention',
			icon: html('<svg></svg>'),
			children: html('Overdue'),
		});
		const pill = q('.pill', el);
		expect(pill.classList.contains('attention')).toBe(true);
		expect(pill.querySelector('svg')).toBeTruthy();
		expect(pill.textContent).toContain('Overdue');
	});
});

describe('IconButton', () => {
	it('is a button named by its label and passes clicks and disabled', () => {
		const spy = vi.fn();
		const el = render(IconButton, {
			label: 'Options for Clio',
			size: 'lg',
			variant: 'outline',
			onclick: spy,
			children: html('<svg></svg>'),
		});
		const b = q('button', el);
		expect(b.getAttribute('aria-label')).toBe('Options for Clio');
		expect(b.classList.contains('lg')).toBe(true);
		click(b);
		expect(spy).toHaveBeenCalledOnce();
		cleanup();
		const off = render(IconButton, { label: 'x', disabled: true, children: html('<i></i>') });
		expect(q('button', off).hasAttribute('disabled')).toBe(true);
	});
});

describe('EmptyState', () => {
	it('shows the title, the hint and the action', () => {
		const el = render(EmptyState, {
			title: 'No vehicles yet',
			hint: 'Add one.',
			icon: html('<svg></svg>'),
			children: html('<button>Add vehicle</button>'),
		});
		expect(q('h3', el).textContent).toBe('No vehicles yet');
		expect(q('p', el).textContent).toBe('Add one.');
		expect(q('.act button', el).textContent).toBe('Add vehicle');
		expect(q('.disc', el).getAttribute('aria-hidden')).toBe('true');
		expect(el.querySelector('svg[data-art]')).toBeNull();
	});

	it('draws the art of every area, in place of the icon, with tokens only', () => {
		for (const name of EMPTY_ART_NAMES) {
			const el = render(EmptyState, { title: 'Nothing yet', art: name, icon: html('<i></i>') });
			const svg = q(`svg[data-art="${name}"]`, el);
			expect(svg.getAttribute('aria-hidden')).toBe('true');
			expect(svg.getAttribute('viewBox')).toBe('0 0 120 88');
			expect(svg.querySelectorAll('path, rect, circle, ellipse').length).toBeGreaterThan(2);
			expect(svg.outerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
			expect(el.querySelector('.disc')).toBeNull();
			cleanup();
		}
		expect(new Set(EMPTY_ART_NAMES).size).toBe(EMPTY_ART_NAMES.length);
	});

	it('stands without art, icon or action', () => {
		const el = render(EmptyState, { title: 'Nothing yet' });
		expect(q('h3', el).textContent).toBe('Nothing yet');
		expect(el.querySelector('svg, .disc, .act, p')).toBeNull();
	});
});

describe('EmptyLine', () => {
	it('shows the icon, the sentence and the optional action', () => {
		let el = render(EmptyLine, { text: 'No papers yet.', icon: html('<svg></svg>') });
		expect(el.textContent).toContain('No papers yet.');
		expect(q('[aria-hidden="true"] svg', el)).toBeTruthy();
		cleanup();
		el = render(EmptyLine, {
			text: 'No papers yet.',
			icon: html('<svg></svg>'),
			children: html('<a href="/add">Share one</a>'),
		});
		expect(q('a', el).textContent).toBe('Share one');
	});
});

describe('Notice', () => {
	it('announces only alerts and has a default icon per tone', () => {
		let el = render(Notice, { children: html('Set by the server.') });
		expect(q('.notice', el).hasAttribute('role')).toBe(false);
		expect(q('svg', el)).toBeTruthy();
		cleanup();
		el = render(Notice, { tone: 'alert', children: html('Careful.') });
		expect(q('.notice', el).getAttribute('role')).toBe('alert');
		expect(q('.notice', el).classList.contains('alert')).toBe(true);
	});
});

describe('Composer', () => {
	it('adds on Enter, clears, ignores empty text and clears on Escape', () => {
		const onsubmit = vi.fn();
		const el = render(Composer, { placeholder: 'Add items', label: 'Add', onsubmit });
		const input = q<HTMLInputElement>('input', el);
		input.focus();
		key(input, 'Enter');
		expect(onsubmit).not.toHaveBeenCalled();
		input.value = '  milk ';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		key(input, 'Enter');
		expect(onsubmit).toHaveBeenCalledWith('milk');
		expect(input.value).toBe('');
		expect(document.activeElement).toBe(input);
		input.value = 'eggs';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		key(input, 'Escape');
		expect(input.value).toBe('');
		expect(input.getAttribute('aria-label')).toBe('Add');
	});

	it('offers "Add details" only once there is text', () => {
		const onmore = vi.fn();
		const el = render(Composer, {
			placeholder: 'Add',
			label: 'Add',
			onsubmit: vi.fn(),
			onmore,
			moreLabel: 'Add details',
		});
		expect(q('.more', el)).toBeNull();
		const input = q<HTMLInputElement>('input', el);
		input.value = 'Sign the form';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		click(q('.more', el));
		expect(onmore).toHaveBeenCalledWith('Sign the form');
	});
});

describe('Menu', () => {
	const open = async (spy = vi.fn()) => {
		const el = render(Menu, { items: items(spy), label: 'Options for Clio', trigger });
		const opener = q('#opener', el);
		opener.focus();
		click(opener);
		await settle();
		return { el, opener };
	};

	it('opens a role=menu with items, a separator before danger, and focuses the first item', async () => {
		const { el } = await open();
		const menu = q('[role=menu]', el);
		expect(menu.getAttribute('aria-label')).toBe('Options for Clio');
		const entries = qa('[role=menuitem]', menu);
		expect(entries.map((e) => e.textContent?.trim())).toEqual(['Edit e', 'Archive', 'Delete']);
		expect(q('[role=separator]', menu)).toBeTruthy();
		expect(entries[2]?.classList.contains('danger')).toBe(true);
		expect(document.activeElement).toBe(entries[0]);
	});

	it('moves with arrow keys, wrapping, Home and End', async () => {
		const { el } = await open();
		const entries = qa('[role=menuitem]', el);
		key(entries[0] as HTMLElement, 'ArrowDown');
		expect(document.activeElement).toBe(entries[1]);
		key(entries[1] as HTMLElement, 'End');
		expect(document.activeElement).toBe(entries[2]);
		key(entries[2] as HTMLElement, 'ArrowDown');
		expect(document.activeElement).toBe(entries[0]);
		key(entries[0] as HTMLElement, 'ArrowUp');
		expect(document.activeElement).toBe(entries[2]);
		key(entries[2] as HTMLElement, 'Home');
		expect(document.activeElement).toBe(entries[0]);
	});

	it('closes on Escape and returns focus to the button', async () => {
		const { el, opener } = await open();
		key(q('[role=menuitem]', el), 'Escape');
		await settle();
		expect(q('[role=menu]', el)).toBeNull();
		expect(document.activeElement).toBe(opener);
	});

	it('runs the chosen action, closes and returns focus', async () => {
		const spy = vi.fn();
		const { el, opener } = await open(spy);
		click(qa('[role=menuitem]', el)[1] as HTMLElement);
		await settle();
		expect(spy).toHaveBeenCalledWith('archive');
		expect(q('[role=menu]', el)).toBeNull();
		expect(document.activeElement).toBe(opener);
	});

	it('closes on a click outside', async () => {
		const { el } = await open();
		document.body.click();
		flushSync();
		expect(q('[role=menu]', el)).toBeNull();
	});
});

describe('ActionSheet', () => {
	it('is a modal dialog titled by the item, with actions and Cancel; Escape closes and returns focus', async () => {
		const spy = vi.fn();
		const opener = document.createElement('button');
		document.body.append(opener);
		opener.focus();
		const el = render(ActionSheet, {
			open: true,
			title: 'Clio',
			items: items(spy),
			cancelLabel: 'Cancel',
		});
		await settle();
		const dialog = q('[role=dialog]', el);
		expect(dialog.getAttribute('aria-modal')).toBe('true');
		expect(q(`#${dialog.getAttribute('aria-labelledby')}`, el).textContent).toBe('Clio');
		const buttons = qa('button', dialog);
		expect(buttons.map((b) => b.textContent?.trim())).toEqual([
			'Edit',
			'Archive',
			'Delete',
			'Cancel',
		]);
		expect(document.activeElement).toBe(buttons[0]);
		click(buttons[0] as HTMLElement);
		expect(spy).toHaveBeenCalledWith('edit');
	});

	it('closes with Escape', async () => {
		const onclose = vi.fn();
		const el = render(ActionSheet, {
			open: true,
			title: 'Clio',
			items: items(),
			cancelLabel: 'Cancel',
			onclose,
		});
		await settle();
		key(q('[role=dialog]', el), 'Escape');
		expect(onclose).toHaveBeenCalledOnce();
	});
});

describe('Sheet', () => {
	it('has Cancel, title and Save in its bar and cancels on Escape', async () => {
		const onclose = vi.fn();
		const onsave = vi.fn();
		const el = render(Sheet, {
			open: true,
			title: 'New task',
			cancelLabel: 'Cancel',
			saveLabel: 'Add',
			onclose,
			onsave,
			children: html('<input id="f" />'),
		});
		await settle();
		const dialog = q('[role=dialog]', el);
		expect(dialog.getAttribute('aria-modal')).toBe('true');
		expect(q('h2', dialog).textContent).toBe('New task');
		const [cancel, save] = qa('header button', dialog);
		expect(cancel?.textContent?.trim()).toBe('Cancel');
		expect(save?.textContent?.trim()).toBe('Add');
		expect(document.activeElement?.id).toBe('f');
		click(save as HTMLElement);
		expect(onsave).toHaveBeenCalledOnce();
		key(q('#f', el), 'Escape');
		expect(onclose).toHaveBeenCalledOnce();
		click(cancel as HTMLElement);
		expect(onclose).toHaveBeenCalledTimes(2);
	});

	it('traps Tab and returns focus to what opened it', async () => {
		const opener = document.createElement('button');
		document.body.append(opener);
		opener.focus();
		const state = box({
			open: true,
			title: 'T',
			cancelLabel: 'Cancel',
			saveLabel: 'Save',
			onclose: () => {},
			onsave: () => {},
			children: html('<input id="f" />'),
		});
		const el = render(Sheet, state);
		await settle();
		const dialog = q('[role=dialog]', el);
		const save = qa('header button', dialog)[1] as HTMLElement;
		const input = q('#f', el);
		// The last focusable in DOM order is the field: Tab from it wraps to the first (Cancel).
		input.focus();
		const wrapped = key(input, 'Tab');
		expect(wrapped.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(qa('header button', dialog)[0]);
		save.focus();
		state.open = false;
		flushSync();
		await settle();
		expect(q('[role=dialog]', el)).toBeNull();
		expect(document.activeElement).toBe(opener);
	});

	it('omits Save for a picker (half sheet)', async () => {
		const el = render(Sheet, {
			open: true,
			half: true,
			title: 'Pick',
			cancelLabel: 'Cancel',
			onclose: () => {},
			children: html('<p>x</p>'),
		});
		await settle();
		expect(qa('header button', el)).toHaveLength(1);
		expect(q('.sheet', el).classList.contains('half')).toBe(true);
	});
});

describe('Dialog', () => {
	it('is a labelled dialog with its actions; focus goes to data-autofocus', async () => {
		const el = render(Dialog, {
			open: true,
			title: 'Sign out everywhere?',
			description: 'Ends your sessions.',
			onclose: () => {},
			actions: html(
				'<span><button id="cancel" data-autofocus>Cancel</button><button id="go">Sign out</button></span>',
			),
		});
		await settle();
		const dialog = q('dialog', el);
		expect(q(`#${dialog.getAttribute('aria-labelledby')}`, el).textContent).toBe(
			'Sign out everywhere?',
		);
		expect(q(`#${dialog.getAttribute('aria-describedby')}`, el).textContent).toBe(
			'Ends your sessions.',
		);
		expect(dialog.hasAttribute('open')).toBe(true);
		expect(document.activeElement?.id).toBe('cancel');
	});

	it('traps Tab, asks to close on Escape and returns focus', async () => {
		const opener = document.createElement('button');
		document.body.append(opener);
		opener.focus();
		const onclose = vi.fn();
		const state = box({
			open: true,
			title: 'T',
			onclose,
			actions: html('<span><button id="a">A</button><button id="b">B</button></span>'),
		});
		const el = render(Dialog, state);
		await settle();
		const dialog = q('dialog', el);
		q('#b', el).focus();
		expect(key(q('#b', el), 'Tab').defaultPrevented).toBe(true);
		expect(document.activeElement?.id).toBe('a');
		expect(key(q('#a', el), 'Tab', { shiftKey: true }).defaultPrevented).toBe(true);
		expect(document.activeElement?.id).toBe('b');
		key(dialog, 'Escape');
		expect(onclose).toHaveBeenCalledOnce();
		state.open = false;
		flushSync();
		await settle();
		expect(q('dialog', el)).toBeNull();
		expect(document.activeElement).toBe(opener);
	});
});

describe('Fab', () => {
	it('is a named 56 px button, a link with href, and can be hidden', () => {
		const spy = vi.fn();
		let el = render(Fab, { label: 'Add vehicle', onclick: spy });
		click(q('button.fab', el));
		expect(spy).toHaveBeenCalledOnce();
		expect(q('button.fab', el).getAttribute('aria-label')).toBe('Add vehicle');
		expect(q('svg', el)).toBeTruthy();
		cleanup();
		el = render(Fab, { label: 'Add', href: '/new' });
		expect(q('a.fab', el).getAttribute('href')).toBe('/new');
		cleanup();
		el = render(Fab, { label: 'Add', hidden: true });
		expect(q('.fab', el)).toBeNull();
	});
});

describe('RecordHeader', () => {
	it('shows the name, the non-empty facts each with its separator, people and actions', () => {
		const el = render(RecordHeader, {
			name: 'Clio',
			facts: ['34 ABC 123', null, 'Petrol'],
			icon: html('<svg></svg>'),
			people: html('<i>A</i>'),
			actions: html('<button>Edit</button>'),
		});
		expect(q('h1', el).textContent).toBe('Clio');
		// The dot is drawn before every fact and clipped at the start of a line, so a wrapped line
		// never ends or begins with one: there is no separate separator element to strand.
		expect(qa('.meta .fact', el).map((s) => s.textContent)).toEqual(['34 ABC 123', 'Petrol']);
		expect(qa('.meta .sep', el)).toHaveLength(0);
		expect(q('.pp', el)).toBeTruthy();
		expect(q('.act button', el).textContent).toBe('Edit');
	});
});

describe('Facts', () => {
	it('is a list of label and value pairs', () => {
		const el = render(Facts, {
			label: 'Totals',
			items: [
				{ label: 'This year', value: '412' },
				{ label: 'Per month', value: '34' },
			],
		});
		expect(q('dl', el).getAttribute('aria-label')).toBe('Totals');
		expect(qa('dt', el).map((d) => d.textContent)).toEqual(['This year', 'Per month']);
		expect(qa('dd', el).map((d) => d.textContent)).toEqual(['412', '34']);
	});
});
