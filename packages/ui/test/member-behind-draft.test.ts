import { describe, expect, it } from 'vitest';
import { askedBy, draftByline, memberBehindDraft, proposedByMember } from '../src/draft-title.ts';

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

describe('draftByline', () => {
	const people = [
		{ id: 'member_a', displayName: 'Ayla' },
		{ id: 'member_b', displayName: 'Bo' },
	];
	const say = (key: string, params?: Record<string, unknown>) =>
		`${key}${params ? JSON.stringify(params) : ''}`;
	const app = { name: 'Home Assistant' };

	it('names the app alone, and the member through the app', () => {
		const alone = { kind: 'app', appId: 'app_1', roleId: 'member', mode: 'suggest' };
		expect(draftByline({ proposedBy: alone, app }, 'member_a', people, say)).toBe(
			'app:draft_by_app{"app":"Home Assistant"}',
		);
		const through = {
			kind: 'member',
			memberId: 'member_b',
			roleId: 'member',
			via: { appId: 'app_1', appRoleId: 'member', mode: 'suggest' },
		};
		expect(draftByline({ proposedBy: through, app }, 'member_a', people, say)).toBe(
			'app:draft_via_app_member{"name":"Bo","app":"Home Assistant"}',
		);
		expect(draftByline({ proposedBy: through, app }, 'member_b', people, say)).toBe(
			'app:draft_via_app{"app":"Home Assistant"}',
		);
	});

	it('is the old asked-by line without an app', () => {
		const by = { kind: 'ai', source: 'mcp', onBehalfOf: 'member_b' };
		expect(draftByline({ proposedBy: by, app: null }, 'member_a', people, say)).toBe(
			'app:draft_asked_by{"name":"Bo"}',
		);
		expect(draftByline({ proposedBy: by }, 'member_b', people, say)).toBeUndefined();
	});
});
