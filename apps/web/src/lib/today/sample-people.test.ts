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

	it('puts the viewer first, even when they are far down the list', () => {
		const members = [member('1'), member('2'), member('3'), member('4'), member('5')];
		expect(samplePeople(members, label, '4').map((p) => p.id)).toEqual(['4', '1', '2']);
		expect(samplePeople(members, label, '1').map((p) => p.id)).toEqual(['1', '2', '3']);
		// Someone who is not a member (or is archived) changes nothing.
		expect(samplePeople(members, label, 'nobody').map((p) => p.id)).toEqual(['1', '2', '3']);
		expect(samplePeople([member('1', true), member('2')], label, '1')[0]?.id).toBe('2');
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
