import { describe, expect, it } from 'vitest';
import { samplePeople } from './sample-people.js';

const label = (key: string) => `[${key}]`;
const member = (id: string, archived = false) => ({
	id,
	displayName: `Name ${id}`,
	color: `#00000${id}`,
	archived,
});

describe('samplePeople', () => {
	it('shows the family’s own first three active members', () => {
		const people = samplePeople(
			[member('1'), member('2', true), member('3'), member('4'), member('5')],
			label,
		);
		expect(people.map((p) => p.id)).toEqual(['1', '3', '4']);
		expect(people[0]).toEqual({ id: '1', displayName: 'Name 1', color: '#000001' });
	});

	it('fills a small family up with made-up people', () => {
		const people = samplePeople([member('1')], label);
		expect(people.map((p) => p.displayName)).toEqual([
			'Name 1',
			'[appearance_sample_person_b]',
			'[appearance_sample_person_c]',
		]);
	});

	it('is all made-up people when no members are known', () => {
		expect(samplePeople([], label).map((p) => p.id)).toEqual(['sample_a', 'sample_b', 'sample_c']);
	});
});
