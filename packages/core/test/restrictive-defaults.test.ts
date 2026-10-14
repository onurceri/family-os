import {
	assertRestrictiveDefaults,
	defaultGrant,
	defineAction,
	defineCapability,
} from '@famos/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildRegistry } from '../src/registry.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

/** Restrictive defaults. */
const roles = (view: boolean, supervised: boolean, guest: boolean) => ({
	admin: true,
	member: view,
	supervised,
	guest,
});

const secretView = defineCapability({
	id: 'stash.view',
	label: 'stash:cap_view',
	level: 'view',
	defaults: roles(true, false, false),
});
const secretEdit = defineCapability({
	id: 'stash.edit',
	label: 'stash:cap_edit',
	level: 'edit',
});
const peek = defineAction({
	id: 'stash.peek',
	title: 'Peek',
	input: z.object({}),
	output: z.object({ ok: z.literal(true) }),
	readOnly: true,
	requires: secretView.id,
	run: async () => ({ ok: true as const }),
});
const stash = defineTestExtension({
	id: 'stash',
	capabilities: [secretView, secretEdit],
	actions: [peek],
});

describe('validation', () => {
	it('lets an extension remove grants its level gives', () => {
		expect(() => defineTestExtension({ id: 'stash', capabilities: [secretView] })).not.toThrow();
		expect(defaultGrant(secretView, 'member')).toBe(true);
		expect(defaultGrant(secretView, 'supervised')).toBe(false);
		expect(defaultGrant(secretView, 'guest')).toBe(false);
	});

	it('refuses a default that adds a grant the level does not give', () => {
		const adds = defineCapability({
			id: 'stash.edit',
			label: 'stash:cap_edit',
			level: 'edit',
			defaults: roles(true, true, false),
		});
		expect(() => defineTestExtension({ id: 'stash', capabilities: [adds] })).toThrow(
			/only remove grants/,
		);
		const guestManage = defineCapability({
			id: 'stash.use',
			label: 'stash:cap_use',
			level: 'use',
			defaults: roles(true, true, true),
		});
		expect(() => defineTestExtension({ id: 'stash', capabilities: [guestManage] })).toThrow(
			/"guest" would gain/,
		);
	});

	it('refuses critical capabilities outside core, in the registry as well', () => {
		const critical = defineCapability({
			id: 'stash.root',
			label: 'stash:cap_root',
			level: 'manage',
			critical: true,
		});
		expect(() => defineTestExtension({ id: 'stash', capabilities: [critical] })).toThrow(
			/critical/,
		);
		// An extension object that skipped defineExtension is still checked when registered.
		const sneaky = { ...stash, capabilities: [critical] };
		expect(() => buildRegistry([sneaky])).toThrow(/critical/);
		const addsLater = {
			...stash,
			capabilities: [{ ...secretEdit, defaults: roles(true, true, true) }],
		};
		expect(() => buildRegistry([addsLater])).toThrow(/only remove grants/);
	});

	it('leaves core free to declare any defaults', () => {
		const pin = defineCapability({
			id: 'core.pin',
			label: 'core:cap_pin',
			level: 'use',
			defaults: roles(true, true, true),
		});
		expect(() => assertRestrictiveDefaults('core', pin)).not.toThrow();
	});
});

describe('grants', () => {
	let k: TestKernel;
	afterEach(() => k.close());

	it('hides the capability from supervised and guest, and custom roles follow their base', async () => {
		k = await createTestKernel({ extensions: [stash] });
		const { actor: admin } = await k.member('admin');
		const peekAs = async (actor: Parameters<typeof k.runner.invoke>[2]) =>
			k.runner.invoke('stash.peek', {}, actor).then(
				(r) => r.status,
				(e: { code?: string }) => e.code ?? 'error',
			);
		expect(await peekAs(admin)).toBe('applied');
		expect(await peekAs((await k.member('member')).actor)).toBe('applied');
		expect(await peekAs((await k.member('supervised')).actor)).toBe('forbidden');
		expect(await peekAs((await k.member('guest')).actor)).toBe('forbidden');

		const create = async (base: string, overrides: Record<string, boolean> = {}) => {
			const r = await k.runner.invoke<{ id: string }>(
				'core.createRole',
				{ name: `From ${base}`, base, overrides },
				admin,
			);
			if (r.status !== 'applied') throw new Error('expected role');
			return r.output.id;
		};
		expect(await peekAs((await k.member(await create('member'))).actor)).toBe('applied');
		expect(await peekAs((await k.member(await create('supervised'))).actor)).toBe('forbidden');
		// A family can still grant it to a custom role.
		const teen = await create('supervised', { 'stash.view': true });
		expect(await peekAs((await k.member(teen)).actor)).toBe('applied');
	});
});
