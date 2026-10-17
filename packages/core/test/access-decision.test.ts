import {
	type Actor,
	type AnyActionDefinition,
	defineAction,
	defineCapability,
	FamosError,
	isFamosError,
	type MemberId,
	systemActor,
} from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ANONYMOUS } from '../src/access.ts';
import { type DecideEnv, type Decision, decide } from '../src/decide.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

// A pantry of jars, with one action for each kind of rule the access decision knows.
const jarsView = defineCapability({ id: 'jars.view', label: 'jars:cap_view', level: 'view' });
const jarsUse = defineCapability({ id: 'jars.use', label: 'jars:cap_use', level: 'use' });
const jarsEdit = defineCapability({ id: 'jars.edit', label: 'jars:cap_edit', level: 'edit' });

/** Jar name → the member who put it on the shelf. */
const shelf = new Map<string, string>();
const Name = z.object({ name: z.string().min(1) });
const Done = z.object({ ok: z.boolean() });
const run = async () => ({ ok: true });

const actions = {
	read: defineAction({
		id: 'jars.read',
		title: 'Read the jars',
		input: Name,
		output: Done,
		readOnly: true,
		requires: jarsView.id,
		run,
	}),
	open: defineAction({
		id: 'jars.open',
		title: 'Open a jar',
		input: Name,
		output: Done,
		requires: jarsUse.id,
		approval: 'never',
		run,
	}),
	fill: defineAction({
		id: 'jars.fill',
		title: 'Fill a jar',
		draftTitle: 'jars:draft_fill',
		input: Name,
		output: Done,
		approval: { unless: jarsEdit.id },
		run,
	}),
	label: defineAction({
		id: 'jars.label',
		title: 'Label a jar',
		draftTitle: 'jars:draft_label',
		input: Name,
		output: Done,
		requires: jarsUse.id,
		approval: { unless: jarsEdit.id, except: (_actor, { name }) => name === 'spare' },
		run,
	}),
	remove: defineAction({
		id: 'jars.remove',
		title: 'Remove a jar',
		draftTitle: 'jars:draft_remove',
		input: Name,
		output: Done,
		requires: jarsUse.id,
		approval: { unless: jarsEdit.id, owner: async (_ctx, { name }) => shelf.get(name) ?? null },
		run,
	}),
	// Without `requires`, owning a jar lets only those who may propose act on it.
	tidy: defineAction({
		id: 'jars.tidy',
		title: 'Tidy a jar',
		draftTitle: 'jars:draft_tidy',
		input: Name,
		output: Done,
		approval: { unless: jarsEdit.id, owner: async (_ctx, { name }) => shelf.get(name) ?? null },
		run,
	}),
	seal: defineAction({
		id: 'jars.seal',
		title: 'Seal a jar',
		draftTitle: 'jars:draft_seal',
		input: Name,
		output: Done,
		requires: jarsUse.id,
		approval: 'always',
		run,
	}),
	weigh: defineAction({
		id: 'jars.weigh',
		title: 'Weigh a jar',
		draftTitle: 'jars:draft_weigh',
		input: Name,
		output: Done,
		requires: jarsUse.id,
		approval: (_actor, { name }) => name === 'heavy',
		run,
	}),
	stock: defineAction({
		id: 'jars.stock',
		title: 'Stock a jar',
		draftTitle: 'jars:draft_stock',
		input: Name,
		output: Done,
		requires: jarsUse.id,
		refuseProposal: async (_ctx, { name }) =>
			name === 'full' ? 'That jar is already full.' : null,
		run,
	}),
} satisfies Record<string, AnyActionDefinition>;

const jars = defineTestExtension({
	id: 'jars',
	capabilities: [jarsView, jarsUse, jarsEdit],
	actions: Object.values(actions),
});

type Who = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let env: DecideEnv;
let admin: Who;
let member: Who;
let kid: Who;
let guest: Who;
/** Guest plus `jars.use`: may use jars directly, but may not propose. */
let helper: Who;
let display: Actor;
let anonymous: Actor;
let ai: Actor;
let kidsAi: Actor;

beforeEach(async () => {
	shelf.clear();
	k = await createTestKernel({ extensions: [jars] });
	env = {
		access: k.access,
		critical: new Set(k.registry.capabilities.filter((c) => c.critical).map((c) => c.id)),
	};
	admin = await k.member('admin');
	member = await k.member('member');
	kid = await k.member('supervised');
	guest = await k.member('guest');
	const role = await k.runner.invoke<{ id: string }>(
		'core.createRole',
		{ name: 'Helper', base: 'guest', overrides: { [jarsUse.id]: true } },
		admin.actor,
	);
	if (role.status !== 'applied') throw new Error('role not created');
	helper = await k.member(role.output.id);
	display = { kind: 'display', deviceId: 'dev_1', capabilities: [jarsView.id], showNames: false };
	anonymous = systemActor(ANONYMOUS);
	ai = { kind: 'ai', mode: 'share', source: 'inbox' };
	kidsAi = {
		kind: 'ai',
		mode: 'conversation',
		source: 'assistant',
		onBehalfOf: kid.member.id as MemberId,
		roleId: kid.actor.roleId,
	};
	shelf.set('kite', kid.member.id);
	shelf.set('honey', helper.member.id);
	shelf.set('jam', member.member.id);
});
afterEach(() => k.close());

const outcome = (d: Decision) => d.outcome;

describe('decide: one answer for every rule', () => {
	it('lets a display run nothing, not even a read', () => {
		expect(decide(actions.read, display, env)).toEqual({ outcome: 'refuse', reason: 'display' });
		expect(decide(actions.open, display, env).outcome).toBe('refuse');
	});

	it('refuses an unauthenticated caller anything that changes data or needs a capability', () => {
		expect(decide(actions.read, anonymous, env)).toEqual({ outcome: 'refuse', reason: 'sign_in' });
		expect(decide(actions.fill, anonymous, env).reason).toBe('sign_in');
	});

	it('refuses a member without `requires`, naming the capability', () => {
		expect(decide(actions.open, guest.actor, env)).toEqual({
			outcome: 'refuse',
			reason: 'capability',
			capability: jarsUse.id,
		});
		expect(decide(actions.open, kid.actor, env)).toEqual({ outcome: 'apply' });
	});

	it('applies `unless` for those who hold it, drafts for those who may propose, refuses others', () => {
		expect(decide(actions.fill, member.actor, env)).toEqual({ outcome: 'apply' });
		expect(decide(actions.fill, kid.actor, env)).toEqual({
			outcome: 'draft',
			reason: 'approval',
			capability: jarsEdit.id,
		});
		expect(decide(actions.fill, guest.actor, env)).toEqual({
			outcome: 'refuse',
			reason: 'approval',
			capability: jarsEdit.id,
		});
	});

	it('marks an `except` as depending on the input, and decides it with the input', () => {
		expect(decide(actions.label, kid.actor, env)).toMatchObject({
			outcome: 'draft',
			depends: true,
		});
		expect(decide(actions.label, kid.actor, env, { input: { name: 'spare' } })).toEqual({
			outcome: 'apply',
			reason: 'except',
		});
		expect(decide(actions.label, kid.actor, env, { input: { name: 'jam' } })).toMatchObject({
			outcome: 'draft',
		});
		// Who may neither apply nor propose still gets the exception.
		expect(decide(actions.label, helper.actor, env)).toMatchObject({
			outcome: 'refuse',
			depends: true,
		});
		expect(decide(actions.label, helper.actor, env, { input: { name: 'spare' } }).outcome).toBe(
			'apply',
		);
		// Holding `unless` decides it whatever the input.
		expect(decide(actions.label, member.actor, env)).toEqual({ outcome: 'apply' });
	});

	it('applies an owner’s change to their own thing, once it knows the owner', () => {
		const input = { name: 'kite' };
		expect(decide(actions.remove, kid.actor, env)).toMatchObject({
			outcome: 'draft',
			depends: true,
		});
		expect(decide(actions.remove, kid.actor, env, { input })).toMatchObject({ depends: true });
		expect(decide(actions.remove, kid.actor, env, { input, owner: kid.member.id })).toEqual({
			outcome: 'apply',
			reason: 'owner',
		});
		expect(decide(actions.remove, kid.actor, env, { input, owner: member.member.id })).toEqual({
			outcome: 'draft',
			reason: 'approval',
			capability: jarsEdit.id,
		});
		expect(decide(actions.remove, kid.actor, env, { input, owner: null }).outcome).toBe('draft');
	});

	it('lets a role that holds `requires` take back its own thing without proposing', () => {
		const input = { name: 'honey' };
		expect(decide(actions.remove, helper.actor, env)).toMatchObject({
			outcome: 'refuse',
			reason: 'approval',
			depends: true,
		});
		expect(decide(actions.remove, helper.actor, env, { input, owner: helper.member.id })).toEqual({
			outcome: 'apply',
			reason: 'owner',
		});
		expect(
			decide(actions.remove, helper.actor, env, { input, owner: member.member.id }),
		).toMatchObject({ outcome: 'refuse', reason: 'approval' });
	});

	it('keeps the owner rule behind proposing when the action has no `requires`', () => {
		expect(decide(actions.tidy, helper.actor, env)).toEqual({
			outcome: 'refuse',
			reason: 'approval',
			capability: jarsEdit.id,
		});
		expect(
			decide(actions.tidy, helper.actor, env, {
				input: { name: 'honey' },
				owner: helper.member.id,
			}),
		).toMatchObject({ outcome: 'refuse' });
		expect(
			decide(actions.tidy, kid.actor, env, { input: { name: 'kite' }, owner: kid.member.id }),
		).toEqual({ outcome: 'apply', reason: 'owner' });
	});

	it('drafts `always` for anyone, and refuses who may not propose', () => {
		expect(decide(actions.seal, admin.actor, env)).toEqual({
			outcome: 'draft',
			reason: 'approval',
		});
		expect(decide(actions.seal, helper.actor, env)).toMatchObject({
			outcome: 'refuse',
			reason: 'approval',
		});
		expect(decide(actions.seal, systemActor('test'), env).outcome).toBe('draft');
	});

	it('asks a policy function only with an input', () => {
		expect(decide(actions.weigh, member.actor, env)).toMatchObject({
			outcome: 'draft',
			depends: true,
		});
		expect(decide(actions.weigh, member.actor, env, { input: { name: 'light' } })).toEqual({
			outcome: 'apply',
		});
		expect(decide(actions.weigh, member.actor, env, { input: { name: 'heavy' } })).toEqual({
			outcome: 'draft',
			reason: 'approval',
		});
	});

	it('makes every change by the AI a draft, and never the owner’s exception', () => {
		expect(decide(actions.open, ai, env)).toEqual({ outcome: 'draft', reason: 'ai' });
		expect(decide(actions.read, ai, env)).toEqual({ outcome: 'apply' });
		expect(
			decide(actions.remove, kidsAi, env, { input: { name: 'kite' }, owner: kid.member.id }),
		).toEqual({ outcome: 'draft', reason: 'ai' });
	});

	it('refuses the AI what the person it works for could not do or propose', () => {
		const guestsAi: Actor = {
			...(kidsAi as object),
			onBehalfOf: guest.member.id,
			roleId: 'guest',
		} as Actor;
		expect(decide(actions.open, guestsAi, env)).toEqual({
			outcome: 'refuse',
			reason: 'ai',
			capability: jarsUse.id,
		});
	});

	it('refuses the AI an area that is off, and a critical capability even for an admin', () => {
		expect(decide(actions.read, ai, { ...env, aiArea: () => 'off' })).toEqual({
			outcome: 'refuse',
			reason: 'area',
		});
		const createRole = k.registry.actions.get('core.createRole');
		if (!createRole) throw new Error('core.createRole missing');
		const adminsAi: Actor = {
			...(kidsAi as object),
			onBehalfOf: admin.member.id,
			roleId: 'admin',
		} as Actor;
		expect(decide(createRole, adminsAi, env)).toEqual({
			outcome: 'refuse',
			reason: 'critical',
			capability: 'core.roles.manage',
		});
		expect(decide(createRole, admin.actor, env).outcome).toBe('apply');
	});

	it('refuses an AI proposal that would change nothing (`refuseProposal`)', () => {
		expect(decide(actions.stock, ai, env, { input: { name: 'full' }, settled: 'full' })).toEqual({
			outcome: 'refuse',
			reason: 'settled',
		});
		// People see what they pick: the AI's rule is not theirs.
		expect(
			decide(actions.stock, member.actor, env, { input: { name: 'full' }, settled: 'full' }),
		).toEqual({ outcome: 'apply' });
	});
});

/** What `invoke` really did, in the decision's words. */
async function invoked(actionId: string, input: unknown, actor: Actor): Promise<string> {
	try {
		const result = await k.runner.invoke(actionId, input, actor);
		return result.status === 'applied' ? 'apply' : 'draft';
	} catch (error) {
		if (isFamosError(error) && (error.code === 'forbidden' || error.code === 'conflict'))
			return 'refuse';
		throw error;
	}
}

describe('the runner and the decision agree', () => {
	const names = ['kite', 'honey', 'jam', 'spare', 'heavy', 'light', 'full', 'nobody'];
	const ids = Object.values(actions).map((a) => a.id);

	it('for every action, actor and input', async () => {
		const actors: [string, () => Actor][] = [
			['admin', () => admin.actor],
			['member', () => member.actor],
			['supervised', () => kid.actor],
			['guest', () => guest.actor],
			['custom', () => helper.actor],
			['display', () => display],
			['anonymous', () => anonymous],
			['ai', () => ai],
			['ai for a child', () => kidsAi],
		];
		let compared = 0;
		for (const id of ids)
			for (const [who, actor] of actors)
				for (const name of names) {
					const input = { name };
					const checked = await k.runner.check(id, input, actor());
					const done = await invoked(id, input, actor());
					expect(`${id} ${who} ${name}: ${done}`).toBe(`${id} ${who} ${name}: ${checked.outcome}`);
					// The answer for any input holds wherever it does not depend on the input.
					const any = decide(k.registry.actions.get(id) as AnyActionDefinition, actor(), env);
					if (!any.depends)
						expect(`${id} ${who} ${name}: ${outcome(any)}`).toBe(`${id} ${who} ${name}: ${done}`);
					compared++;
				}
		expect(compared).toBe(ids.length * actors.length * names.length);
	});

	it('answers a check without running anything or recording it', async () => {
		const audit = () =>
			k.ctx.db
				.withTables<{ core_audit_log: { id: number } }>()
				.selectFrom('core_audit_log')
				.select((eb) => eb.fn.countAll<number>().as('n'))
				.executeTakeFirstOrThrow();
		const before = await audit();
		expect(await k.runner.check('jars.remove', { name: 'kite' }, kid.actor)).toEqual({
			outcome: 'apply',
			reason: 'owner',
		});
		expect(await k.runner.check('jars.fill', { name: 'jam' }, kid.actor)).toMatchObject({
			outcome: 'draft',
		});
		expect(await audit()).toEqual(before);
		expect(shelf.has('kite')).toBe(true);
	});

	it('checks the input like a call does', async () => {
		await expect(k.runner.check('jars.fill', { name: '' }, kid.actor)).rejects.toMatchObject({
			code: 'bad_request',
		});
		await expect(k.runner.check('jars.nothing', {}, kid.actor)).rejects.toMatchObject({
			code: 'not_found',
		});
		// A refusal for any input needs no valid input to say so.
		expect(await k.runner.check('jars.open', {}, guest.actor)).toMatchObject({ outcome: 'refuse' });
	});
});

describe('refusals say why, never which action', () => {
	it('carries the reason and the capability', async () => {
		const error = await k.runner.invoke('jars.fill', { name: 'jam' }, guest.actor).catch((e) => e);
		expect(error).toBeInstanceOf(FamosError);
		expect(error).toMatchObject({
			code: 'forbidden',
			details: { reason: 'approval', capability: jarsEdit.id },
		});
		expect(error.message).not.toContain('jars');
		const display_ = await k.runner.invoke('jars.read', { name: 'x' }, display).catch((e) => e);
		expect(display_).toMatchObject({ code: 'forbidden', details: { reason: 'display' } });
	});
});

describe('the owner of a thing, in a role that may not propose', () => {
	it('removes what they added directly, and nothing of anyone else', async () => {
		expect(await k.runner.invoke('jars.remove', { name: 'honey' }, helper.actor)).toMatchObject({
			status: 'applied',
		});
		await expect(
			k.runner.invoke('jars.remove', { name: 'jam' }, helper.actor),
		).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'approval' } });
	});

	it('gives the AI and a display nothing', async () => {
		const helpersAi: Actor = {
			kind: 'ai',
			mode: 'agent',
			source: 'mcp',
			onBehalfOf: helper.member.id as MemberId,
			roleId: helper.actor.roleId,
		};
		expect(await invoked('jars.remove', { name: 'honey' }, helpersAi)).not.toBe('apply');
		expect(await invoked('jars.remove', { name: 'honey' }, display)).toBe('refuse');
	});
});

describe('GET /core/access', () => {
	const access = (actor: Actor) => k.route('core.getAccess').call({ actor });

	it('answers every data-changing action for the viewer, and marks what depends on the input', async () => {
		const { actions: mine } = (await access(kid.actor)) as { actions: Record<string, Decision> };
		expect(mine['jars.open']).toEqual({ outcome: 'apply' });
		expect(mine['jars.fill']).toEqual({
			outcome: 'draft',
			reason: 'approval',
			capability: jarsEdit.id,
		});
		expect(mine['jars.remove']).toMatchObject({ outcome: 'draft', depends: true });
		expect(mine['jars.read']).toBeUndefined();
		expect(mine['core.createRole']).toMatchObject({ outcome: 'refuse', reason: 'capability' });
		const { actions: guests } = (await access(guest.actor)) as {
			actions: Record<string, Decision>;
		};
		expect(guests['jars.open']).toMatchObject({ outcome: 'refuse', capability: jarsUse.id });
		const { actions: admins } = (await access(admin.actor)) as {
			actions: Record<string, Decision>;
		};
		expect(admins['jars.remove']).toEqual({ outcome: 'apply' });
	});

	it('leaves out the actions of an extension that is turned off', async () => {
		await k.runner.invoke(
			'core.setFeatureEnabled',
			{ extensionId: 'jars', enabled: false },
			systemActor('test'),
		);
		const { actions: mine } = (await access(kid.actor)) as { actions: Record<string, Decision> };
		expect(mine['jars.open']).toBeUndefined();
	});
});
