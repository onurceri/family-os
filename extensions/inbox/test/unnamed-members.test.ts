import { describe, expect, it } from 'vitest';
import { unnamedMemberFields } from '../src/server/process.ts';

const members = [
	{ id: 'member_a', displayName: 'Sofia Brandt' },
	{ id: 'member_b', displayName: 'Ellie' },
	{ id: 'member_c', displayName: 'Ali' },
];

describe('unnamedMemberFields', () => {
	it('marks a member the item never names', () => {
		// Found in use: a swim-club fee was assigned to Sofia although the message named nobody.
		const text = 'Swim club: the autumn term fee of 120 is due by Friday 16 October.';
		expect(
			unnamedMemberFields({ title: 'Pay', assigneeId: 'member_a' }, members, text, 'en'),
		).toEqual(['assigneeId']);
	});

	it('leaves a named member alone, by any part of their name and in any case', () => {
		expect(
			unnamedMemberFields(
				{ memberIds: ['member_a', 'member_b'] },
				members,
				'SOFIA and ellie: dentist',
				'en',
			),
		).toEqual([]);
	});

	it('marks a list when one of its members is not named', () => {
		expect(
			unnamedMemberFields(
				{ memberIds: ['member_b', 'member_c'] },
				members,
				'Ellie has choir',
				'en',
			),
		).toEqual(['memberIds']);
	});

	it('does not match a name inside another word', () => {
		expect(
			unnamedMemberFields({ assigneeId: 'member_c' }, members, 'Call the alien museum', 'en'),
		).toEqual(['assigneeId']);
	});

	it('ignores empty lists and fields that are not members', () => {
		expect(
			unnamedMemberFields({ memberIds: [], title: 'Swim', tags: ['school'] }, members, '', 'en'),
		).toEqual([]);
	});
});
