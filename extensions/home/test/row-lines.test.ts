import { describe, expect, it } from 'vitest';
import { itemLine, serviceLine } from '../src/web/row-lines.ts';

describe('itemLine', () => {
	it('says the room, then the make', () => {
		expect(itemLine({ room: 'Kitchen', brand: 'Bosch', model: 'Serie 4' })).toBe(
			'Kitchen · Bosch Serie 4',
		);
		expect(itemLine({ room: '', brand: 'Bosch', model: '' })).toBe('Bosch');
		expect(itemLine({})).toBe('');
	});
});

describe('serviceLine', () => {
	const day = (n: number) => `day ${n}`;

	it('says the kind, then the billing day', () => {
		expect(serviceLine({ dueDay: 5 }, 'Electricity', day)).toBe('Electricity · day 5');
		expect(serviceLine({ dueDay: null }, 'Electricity', day)).toBe('Electricity');
	});
});
