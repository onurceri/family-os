import type { AccessControl, Actor } from '@famos/sdk';
import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/http/env.ts';
import { requireCapability, requirePerson, requireSignedIn } from '../src/http/route-kit.ts';

const context = (actor: Actor | null) =>
	({ get: (key: string) => (key === 'actor' ? actor : null) }) as unknown as Context<AppEnv>;

const person = { kind: 'member', memberId: 'member_1', roleId: 'admin' } as unknown as Actor;
const viaApp = { ...person, via: { appId: 'app_1', mode: 'act' } } as unknown as Actor;
const app = { kind: 'app', appId: 'app_1', roleId: 'admin', mode: 'act' } as unknown as Actor;
const display = {
	kind: 'display',
	deviceId: 'device_1',
	capabilities: ['calendar.view'],
	showNames: false,
} as unknown as Actor;
const ai = { kind: 'ai', mode: 'agent', source: 'mcp' } as unknown as Actor;

const holds = (...granted: string[]): AccessControl =>
	({ can: (_actor: Actor, capability: string) => granted.includes(capability) }) as AccessControl;

describe('requirePerson', () => {
	it('admits only a member present themselves', () => {
		expect(requirePerson(context(person))).toBe(person);
		for (const other of [null, viaApp, app, display, ai])
			expect(() => requirePerson(context(other))).toThrow('Sign in required');
	});
});

describe('requireSignedIn', () => {
	it('admits any caller the door authenticated, and nobody else', () => {
		for (const caller of [person, viaApp, app, display, ai])
			expect(requireSignedIn(context(caller))).toBe(caller);
		expect(() => requireSignedIn(context(null))).toThrow('Sign in required');
	});
});

describe('requireCapability', () => {
	it('refuses a caller who is not signed in before asking about the capability', () => {
		expect(() => requireCapability(context(null), holds('x.manage'), 'x.manage', 'No')).toThrow(
			'Sign in required',
		);
	});

	it('refuses one who lacks the capability with the route own message', () => {
		expect(() => requireCapability(context(display), holds(), 'x.manage', 'Not allowed')).toThrow(
			'Not allowed',
		);
	});

	it('admits one who holds it, of any caller kind the access control grants', () => {
		expect(requireCapability(context(person), holds('x.manage'), 'x.manage', 'No')).toBe(person);
	});
});
