import { describe, expect, it } from 'vitest';
import { nameTwin } from './member-names.js';

const members = [
	{ id: 'a', displayName: 'Nina' },
	{ id: 'b', displayName: 'Ivy' },
	{ id: 'c', displayName: 'Nina' },
];

describe('nameTwin', () => {
	it('finds another member with the name, ignoring case and outer spaces', () => {
		expect(nameTwin(members, ' nina ')?.id).toBe('a');
		expect(nameTwin(members, 'Mara')).toBeUndefined();
		expect(nameTwin(members, '  ')).toBeUndefined();
	});

	it('does not count the member themselves, nor a name they already have', () => {
		expect(nameTwin(members, 'Ivy', members[1])).toBeUndefined();
		expect(nameTwin(members, 'Nina', members[2])).toBeUndefined();
		expect(nameTwin(members, 'Ivy', members[0])?.id).toBe('b');
	});
});
