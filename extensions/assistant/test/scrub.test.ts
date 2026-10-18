import { describe, expect, it } from 'vitest';
import {
	createHandleScrubber,
	scrubHandles,
	scrubRecordHandles,
	withoutToolMarkup,
} from '../src/server/scrub.ts';

const name = (handle: string) => (handle === 'member:1' ? 'Ayşe' : 'someone');

describe('scrubHandles', () => {
	it('swaps member handles for names and leaves other text alone', () => {
		expect(scrubHandles('member:1 and member:12 meet; remember:1 stays; vehicle:1', name)).toBe(
			'Ayşe and someone meet; remember:1 stays; vehicle:1',
		);
	});
});

describe('the streaming scrubber', () => {
	const run = (pieces: string[]) => {
		const scrubber = createHandleScrubber(name);
		return pieces.map((p) => scrubber.push(p)).join('') + scrubber.flush();
	};

	it('swaps a handle even when it is cut between pieces', () => {
		expect(run(['Hello mem', 'ber', ':', '1 is here'])).toBe('Hello Ayşe is here');
		expect(run(['member:', '1', '2 ok'])).toBe('someone ok');
		expect(run(['Ask m', 'e now, Tom', ' and member:1'])).toBe('Ask me now, Tom and Ayşe');
	});

	it('gives out held text at the end', () => {
		expect(run(['Dear member'])).toBe('Dear member');
		expect(run(['Tom'])).toBe('Tom');
	});

	it('does not touch a word that merely ends like a handle', () => {
		expect(run(['re', 'member:1 it'])).toBe('remember:1 it');
	});
});

describe('a complete answer', () => {
	it('drops tool calls written out as text (real model answer)', () => {
		// nemotron-120b, on the step with no tools left.
		const written =
			'<tool_call>\n<function=lists_shoppingListMarkBought>\n<parameter=listId>\nshop_list:2\n</parameter>\n<parameter=itemId>\nshop_item:1\n</parameter>\n</function>\n</tool_call>';
		expect(withoutToolMarkup(written)).toBe('');
		expect(withoutToolMarkup('Done. <tool_call>\n<function=x>')).toBe('Done.');
		expect(withoutToolMarkup('Milk is on the list.')).toBe('Milk is on the list.');
	});

	it('names the records whose handles it writes', () => {
		const title = (handle: string) => (handle === 'shop_item:1' ? 'Oat milk' : null);
		expect(scrubRecordHandles('Tick off shop_item:1 at 10:30?', title)).toBe(
			'Tick off Oat milk at 10:30?',
		);
		expect(scrubRecordHandles('ratio 3:1 and note:4', title)).toBe('ratio 3:1 and note:4');
	});
});
