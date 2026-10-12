import {
	createHandleTable,
	namesUnknownId,
	repairInput,
	typedIdKind,
	unknownIdFields,
	withHandles,
} from '@famos/sdk';
import { describe, expect, it } from 'vitest';

const id = (prefix: string, n: number) =>
	`${prefix}_01990000-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('handle table', () => {
	it('gives short stable handles per kind and maps them back', () => {
		const table = createHandleTable();
		expect(table.add('member', id('member', 1))).toBe('member:1');
		expect(table.add('member', id('member', 2))).toBe('member:2');
		expect(table.add('vehicle', id('vehicle', 1))).toBe('vehicle:1');
		// The same id keeps its handle, whatever kind is named the second time.
		expect(table.add('car', id('member', 2))).toBe('member:2');
		expect(table.toId.get('member:2')).toBe(id('member', 2));
		expect(table.handleOf(id('vehicle', 1))).toBe('vehicle:1');
		expect(table.ids().size).toBe(3);
	});

	it('replaces typed ids in a value, deeply, and leaves other text alone', () => {
		const table = createHandleTable();
		const out = withHandles(
			{
				who: [id('member', 7)],
				car: { id: id('vehicle', 3), name: 'Clio', url: `/vehicles/${id('vehicle', 3)}` },
				n: 3,
			},
			table,
		);
		expect(out).toEqual({
			who: ['member:1'],
			car: { id: 'vehicle:1', name: 'Clio', url: `/vehicles/${id('vehicle', 3)}` },
			n: 3,
		});
		expect(typedIdKind(id('fin_bill', 1))).toBe('fin_bill');
		expect(typedIdKind('member:1')).toBeNull();
	});

	it('spots ids the model was never shown, after handles are mapped back', () => {
		const table = createHandleTable();
		table.add('member', id('member', 1));
		const mapped = repairInput({ memberIds: ['member:1'], note: 'x' }, table.toId);
		expect(mapped).toEqual({ memberIds: [id('member', 1)], note: 'x' });
		expect(namesUnknownId(mapped, table)).toBe(false);
		expect(namesUnknownId({ memberIds: [id('member', 9)] }, table)).toBe(true);
		expect(namesUnknownId({ deep: [{ x: id('vehicle', 1) }] }, table)).toBe(true);
	});

	it('names the fields that hold an id the model was never shown', () => {
		const table = createHandleTable();
		table.add('member', id('member', 1));
		expect(
			unknownIdFields(
				{ listId: id('shop_list', 4), who: [id('member', 1)], items: [{ id: id('shop_item', 2) }] },
				table,
			),
		).toEqual(['listId', 'items[0].id']);
	});

	it('repairs null fields and JSON written as text', () => {
		expect(repairInput({ a: null, b: '[1,2]', c: '{"d":null}', e: 'text [x]' })).toEqual({
			b: [1, 2],
			c: {},
			e: 'text [x]',
		});
	});
});
