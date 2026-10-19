import { describe, expect, it } from 'vitest';
import {
	type Actor,
	isFullSignIn,
	type MemberId,
	memberBehind,
	personPresent,
	principalOf,
	selfOf,
} from '../src/index.ts';

const leo = 'member_leo' as MemberId;
const member: Actor = { kind: 'member', memberId: leo, roleId: 'member' };
const pinMember: Actor = { kind: 'member', memberId: leo, roleId: 'member', pin: true };
const aiForLeo: Actor = {
	kind: 'ai',
	mode: 'conversation',
	source: 'assistant',
	sourceId: 'thread_1',
	onBehalfOf: leo,
	roleId: 'member',
};
const aiForNobody: Actor = { kind: 'ai', mode: 'share', source: 'inbox' };
const display: Actor = { kind: 'display', deviceId: 'dev_1', capabilities: [], showNames: false };
const system: Actor = { kind: 'system', source: 'queue' };
const fake = { kind: 'robot' } as unknown as Actor;

describe('memberBehind', () => {
	it('is the member itself, or the member the AI works for', () => {
		expect(memberBehind(member)).toBe(leo);
		expect(memberBehind(pinMember)).toBe(leo);
		expect(memberBehind(aiForLeo)).toBe(leo);
	});

	it('is null when nobody in particular is behind it', () => {
		expect(memberBehind(aiForNobody)).toBeNull();
		expect(memberBehind(display)).toBeNull();
		expect(memberBehind(system)).toBeNull();
		expect(memberBehind(fake)).toBeNull();
	});
});

describe('selfOf', () => {
	it('is the member acting for themselves and no one else', () => {
		expect(selfOf(member)).toBe(leo);
		expect(selfOf(pinMember)).toBe(leo);
		expect(selfOf(aiForLeo)).toBeNull();
		expect(selfOf(aiForNobody)).toBeNull();
		expect(selfOf(display)).toBeNull();
		expect(selfOf(system)).toBeNull();
		expect(selfOf(fake)).toBeNull();
	});
});

describe('personPresent', () => {
	it('is true only for a member acting directly', () => {
		expect(personPresent(member)).toBe(true);
		expect(personPresent(pinMember)).toBe(true);
		expect(personPresent(aiForLeo)).toBe(false);
		expect(personPresent(aiForNobody)).toBe(false);
		expect(personPresent(display)).toBe(false);
		expect(personPresent(system)).toBe(false);
		expect(personPresent(fake)).toBe(false);
	});

	it('is what a full sign-in builds on', () => {
		expect(isFullSignIn(member)).toBe(true);
		expect(isFullSignIn(pinMember)).toBe(false);
		expect(isFullSignIn(aiForLeo)).toBe(false);
	});
});

describe('principalOf', () => {
	it('names who acted, stably', () => {
		expect(principalOf(member)).toBe('member:member_leo');
		expect(principalOf(pinMember)).toBe('member:member_leo');
		expect(principalOf(aiForLeo)).toBe('ai:assistant:thread_1');
		expect(principalOf(aiForNobody)).toBe('ai:inbox');
		expect(principalOf(display)).toBe('display:dev_1');
		expect(principalOf(system)).toBe('system:queue');
	});

	it('does not confuse an unknown kind with a known one', () => {
		expect(principalOf(fake)).toBe('unknown');
	});
});
