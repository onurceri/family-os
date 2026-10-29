import { describe, expect, it } from 'vitest';
import {
	addBatch,
	failed,
	noPendingAdds,
	pendingItems,
	readApplied,
	readBegun,
	saved,
} from '../src/web/pending-adds.ts';

const bread = { listId: 'list_1', title: 'Bread' };
const titles = (state: Parameters<typeof pendingItems>[0]) =>
	pendingItems(state, 'list_1').map((i) => i.title);

describe('items being added', () => {
	it('stay until a read that began after the save lands, even when an older read lands first', () => {
		let { state, batch } = addBatch(noPendingAdds, [bread]);
		// A realtime read starts while the add is on its way.
		const early = readBegun(state);
		state = saved(early.state, batch);
		// The page's own read after the save, overtaken by the event's read, is never applied...
		const own = readBegun(state);
		state = own.state;
		const event = readBegun(state);
		state = event.state;
		// ...and the read that began before the save lands: the items stay.
		state = readApplied(state, early.read);
		expect(titles(state)).toEqual(['Bread']);
		// The newest read holds the new rows: now they go.
		state = readApplied(state, event.read);
		expect(titles(state)).toEqual([]);
	});

	it('stay while the add is being saved, whatever read lands', () => {
		let { state } = addBatch(noPendingAdds, [bread]);
		const read = readBegun(state);
		state = readApplied(read.state, read.read);
		expect(titles(state)).toEqual(['Bread']);
	});

	it('go at once when the add fails, leaving other batches alone', () => {
		const first = addBatch(noPendingAdds, [bread]);
		const second = addBatch(first.state, [{ listId: 'list_1', title: 'Milk' }]);
		expect(titles(second.state)).toEqual(['Bread', 'Milk']);
		expect(titles(failed(second.state, first.batch))).toEqual(['Milk']);
	});

	it('shows only the chosen list’s items', () => {
		const { state } = addBatch(noPendingAdds, [bread, { listId: 'list_2', title: 'Plasters' }]);
		expect(titles(state)).toEqual(['Bread']);
		expect(pendingItems(state, 'list_2').map((i) => i.title)).toEqual(['Plasters']);
	});
});
