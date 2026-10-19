import { describe, expect, it } from 'vitest';
import { askedBy, memberBehindDraft, proposedByMember } from '../src/draft-title.ts';

describe('memberBehindDraft', () => {
	it('is the member who proposed it, or who the AI works for', () => {
		expect(memberBehindDraft({ kind: 'member', memberId: 'member_a', roleId: 'member' })).toBe(
			'member_a',
		);
		expect(memberBehindDraft({ kind: 'ai', source: 'mcp', onBehalfOf: 'member_b' })).toBe(
			'member_b',
		);
	});

	it('is nobody for the system, a display, an AI for no one or something unreadable', () => {
		expect(memberBehindDraft({ kind: 'system', source: 'queue' })).toBeUndefined();
		expect(memberBehindDraft({ kind: 'display', deviceId: 'dev_1' })).toBeUndefined();
		expect(memberBehindDraft({ kind: 'ai', source: 'inbox' })).toBeUndefined();
		expect(memberBehindDraft({ kind: 'robot', onBehalfOf: 'member_c' })).toBeUndefined();
		expect(memberBehindDraft(null)).toBeUndefined();
		expect(memberBehindDraft('member_a')).toBeUndefined();
	});

	it('drives who may withdraw and who is named as asking', () => {
		const by = { kind: 'ai', source: 'mcp', onBehalfOf: 'member_b' };
		expect(proposedByMember(by, 'member_b')).toBe(true);
		expect(proposedByMember(by, 'member_a')).toBe(false);
		expect(proposedByMember({ kind: 'system', source: 'queue' }, 'member_a')).toBe(false);
		const people = [{ id: 'member_b', displayName: 'Bo' }];
		expect(askedBy(by, 'member_a', people)).toBe('Bo');
		expect(askedBy(by, 'member_b', people)).toBeUndefined();
	});
});
