import {
	type Actor,
	appOf,
	defineAction,
	defineCapability,
	isFamosError,
	memberBehind,
	personPresent,
	principalOf,
	selfOf,
} from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { appMayHold } from '../src/access.ts';
import { API_TOKEN_PREFIX } from '../src/api-tokens.ts';
import type { AppCaller, AppView } from '../src/apps.ts';
import { CORE_CAPABILITIES } from '../src/core-capabilities.ts';
import { decide } from '../src/decide.ts';
import type { CoreTables } from '../src/tables.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

const cupsUse = defineCapability({ id: 'cups.use', label: 'cups:cap_use', level: 'use' });
const cupsEdit = defineCapability({ id: 'cups.edit', label: 'cups:cap_edit', level: 'edit' });
const cupsManage = defineCapability({
	id: 'cups.manage',
	label: 'cups:cap_manage',
	level: 'manage',
});

const poured: string[] = [];
const Name = z.object({ name: z.string(), memberId: z.string().optional() });
const Done = z.object({ ok: z.boolean() });

const pour = defineAction({
	id: 'cups.pour',
	title: 'Pour a cup',
	draftTitle: 'cups:draft_pour',
	input: Name,
	output: Done,
	requires: cupsUse.id,
	approval: {
		unless: cupsEdit.id,
		// Their own cup: a member (also through an app) pours it directly.
		except: (actor, input) => {
			const self = selfOf(actor);
			return self !== null && input.memberId === self;
		},
	},
	undo: () => ({ actionId: 'cups.pour', input: { name: 'undo' } }),
	async run(_uow, { name }) {
		poured.push(name);
		return { ok: true };
	},
});
// An action that never needs approval for a member.
const drink = defineAction({
	id: 'cups.drink',
	title: 'Drink a cup',
	draftTitle: 'cups:draft_pour',
	input: Name,
	output: Done,
	requires: cupsUse.id,
	approval: 'never',
	async run(_uow, { name }) {
		poured.push(`drink ${name}`);
		return { ok: true };
	},
});
const brew = defineAction({
	id: 'cups.brew',
	title: 'Brew a pot',
	input: Name,
	output: Done,
	requires: cupsManage.id,
	approval: 'never',
	async run(_uow, { name }) {
		poured.push(`brew ${name}`);
		return { ok: true };
	},
});
const peek = defineAction({
	id: 'cups.peek',
	title: 'Peek into a cup',
	input: Name,
	output: z.number(),
	readOnly: true,
	requires: cupsUse.id,
	run: async () => poured.length,
});
const serve = defineAction({
	id: 'cups.serve',
	title: 'Serve a cup',
	input: Name,
	output: Done,
	requires: cupsUse.id,
	approval: 'never',
	run: (uow, input) => uow.run('cups.pour', input),
});
const cups = defineTestExtension({
	id: 'cups',
	capabilities: [cupsUse, cupsEdit, cupsManage],
	actions: [pour, drink, brew, peek, serve],
});

let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
beforeEach(async () => {
	poured.length = 0;
	k = await createTestKernel({ extensions: [cups] });
	admin = await k.member('admin');
});
afterEach(() => k.close());

const make = async (
	roleId: string,
	mode: 'apply' | 'suggest' = 'apply',
	actsFor: string[] = [],
): Promise<{ app: AppView; secret: string }> => {
	const created = await k.apps.create(admin.actor, {
		name: 'Home Assistant',
		roleId,
		mode,
		actsFor,
	});
	const { secret } = await k.apps.createToken(admin.actor, created.id, { name: created.name });
	const app = (await k.apps.list(admin.actor)).find((a) => a.id === created.id);
	if (!app) throw new Error('app missing');
	return { app, secret };
};

/** Who the key is, with the member it names. */
async function caller(secret: string, memberId?: string): Promise<AppCaller> {
	const found = await k.apps.authenticate(secret, memberId);
	if (!found) throw new Error('key not accepted');
	return found;
}

const codeOf = (promise: Promise<unknown>) =>
	promise.then(
		() => 'ok',
		(e: unknown) => (isFamosError(e) ? e.code : 'other'),
	);

const kindOf = async (promise: Promise<{ status: string }>) => (await promise).status;
const run = (id: string, actor: Actor, input: Record<string, unknown> = { name: 'tea' }) =>
	k.runner.invoke(id, input, actor);

describe('the app kind and the member through an app', () => {
	it('an app alone follows its role: apply, draft or refuse', async () => {
		const member = await make('member');
		const app = (await caller(member.secret)).actor;
		expect(app).toMatchObject({ kind: 'app', roleId: 'member', mode: 'apply' });
		expect(await kindOf(run('cups.pour', app))).toBe('applied');
		expect(await kindOf(run('cups.peek', app))).toBe('applied');
		// `cups.manage` is a manage-level capability the member role does not hold.
		expect(await codeOf(run('cups.brew', app))).toBe('forbidden');

		const supervised = await make('supervised');
		const kid = (await caller(supervised.secret)).actor;
		// Uses cups but may not edit them: its pour waits for a person.
		expect(await kindOf(run('cups.pour', kid))).toBe('drafted');
		expect(await kindOf(run('cups.drink', kid))).toBe('applied');

		const guest = await make('guest');
		const nobody = (await caller(guest.secret)).actor;
		expect(await codeOf(run('cups.pour', nobody))).toBe('forbidden');
		expect(await codeOf(run('cups.peek', nobody))).toBe('forbidden');
	});

	it('an app alone is nobody: it has no member behind it and no own things', async () => {
		const { secret } = await make('member');
		const actor = (await caller(secret)).actor;
		expect(memberBehind(actor)).toBeNull();
		expect(selfOf(actor)).toBeNull();
		expect(personPresent(actor)).toBe(false);
		expect(principalOf(actor)).toMatch(/^app:app_/);
		// The "own cup" exception needs a self: an app alone never has one.
		const result = await run('cups.pour', (await caller((await make('supervised')).secret)).actor, {
			name: 'mine',
			memberId: admin.member.id,
		});
		expect(result.status).toBe('drafted');
	});

	it('an app for an allowed member is that member, through the app, with no person present', async () => {
		const leo = await k.member('member');
		const { secret, app } = await make('member', 'apply', [leo.member.id]);
		const found = await caller(secret, leo.member.id);
		expect(found.actor).toMatchObject({
			kind: 'member',
			memberId: leo.member.id,
			via: { appId: app.id, appRoleId: 'member', mode: 'apply' },
		});
		expect(found.memberId).toBe(leo.member.id);
		expect(personPresent(found.actor)).toBe(false);
		expect(selfOf(found.actor)).toBe(leo.member.id);
		expect(memberBehind(found.actor)).toBe(leo.member.id);
		expect(appOf(found.actor)).toMatchObject({ appId: app.id });
		expect(principalOf(found.actor)).toBe(`app:${app.id}/member:${leo.member.id}`);
		expect(await kindOf(run('cups.pour', found.actor))).toBe('applied');
	});

	it('an app naming a member it may not act for is refused with 403, and so is an archived one', async () => {
		const leo = await k.member('member');
		const ivy = await k.member('member');
		const { secret } = await make('member', 'apply', [leo.member.id]);
		await expect(k.apps.authenticate(secret, ivy.member.id)).rejects.toMatchObject({
			code: 'forbidden',
			details: { reason: 'on_behalf' },
		});
		await expect(k.apps.authenticate(secret, 'member_nobody')).rejects.toMatchObject({
			code: 'forbidden',
		});
		// An archived member is refused; the app's own role keeps working.
		await k.runner.invoke('core.archiveMember', { memberId: leo.member.id }, admin.actor);
		await expect(k.apps.authenticate(secret, leo.member.id)).rejects.toMatchObject({
			code: 'forbidden',
		});
		const alone = await caller(secret);
		expect(alone.actor.kind).toBe('app');
		expect(await kindOf(run('cups.pour', alone.actor))).toBe('applied');
	});

	it('holds the intersection of the member and the app role, for every pairing', async () => {
		const roles = ['admin', 'member', 'supervised', 'guest'] as const;
		const rank = { admin: 3, member: 2, supervised: 1, guest: 0 } as const;
		const both = (a: (typeof roles)[number], m: (typeof roles)[number]) => {
			const level = Math.min(rank[a], rank[m]);
			// guest 0: nothing at use; supervised 1: use, no edit; member and admin 2+: edit.
			return level === 0 ? 'forbidden' : level === 1 ? 'drafted' : 'applied';
		};
		for (const appRole of roles) {
			for (const memberRole of roles) {
				const person = await k.member(memberRole);
				const { secret } = await make(appRole, 'apply', [person.member.id]);
				const { actor } = await caller(secret, person.member.id);
				const expected = both(appRole, memberRole);
				const outcome =
					expected === 'forbidden'
						? await codeOf(run('cups.pour', actor))
						: await kindOf(run('cups.pour', actor));
				expect(`${appRole}/${memberRole}:${outcome}`).toBe(`${appRole}/${memberRole}:${expected}`);
			}
		}
	});

	it('a member keeps their own thing through an app when both could propose it', async () => {
		const kid = await k.member('supervised');
		const { secret } = await make('member', 'apply', [kid.member.id]);
		const { actor } = await caller(secret, kid.member.id);
		// Someone else's cup: the supervised member may only suggest it.
		expect(await kindOf(run('cups.pour', actor, { name: 'x', memberId: admin.member.id }))).toBe(
			'drafted',
		);
		// Their own cup: theirs to pour directly.
		expect(await kindOf(run('cups.pour', actor, { name: 'y', memberId: kid.member.id }))).toBe(
			'applied',
		);
	});

	it('is never critical and never holds the excluded set, whatever role the admin picks', async () => {
		const person = await k.member('admin');
		const { secret } = await make('admin', 'apply', [person.member.id]);
		const own = (await caller(secret)).actor;
		const behind = (await caller(secret, person.member.id)).actor;
		const excluded = [
			CORE_CAPABILITIES.draftsApprove.id,
			CORE_CAPABILITIES.mcpUse.id,
			CORE_CAPABILITIES.signInPin.id,
		];
		for (const capability of k.access.capabilities) {
			const barred = capability.critical === true || excluded.includes(capability.id);
			for (const actor of [own, behind]) {
				expect(`${capability.id} ${k.access.can(actor, capability.id)}`).toBe(
					barred
						? `${capability.id} false`
						: `${capability.id} ${k.access.effective('admin').has(capability.id)}`,
				);
			}
			expect(appMayHold(capability)).toBe(!barred);
		}
		// The admin role itself still holds all of it.
		expect(k.access.can(person.actor, CORE_CAPABILITIES.rolesManage.id)).toBe(true);
		expect(k.access.can(own, CORE_CAPABILITIES.appsManage.id)).toBe(false);
	});

	it('cannot run what a critical or person-only capability guards, nor decide drafts', async () => {
		const person = await k.member('admin');
		const { secret } = await make('admin', 'apply', [person.member.id]);
		for (const actor of [
			(await caller(secret)).actor,
			(await caller(secret, person.member.id)).actor,
		]) {
			expect(
				await codeOf(run('core.createRole', actor, { name: 'X', base: 'guest', overrides: {} })),
			).toBe('forbidden');
			expect(await codeOf(run('core.archiveMember', actor, { memberId: person.member.id }))).toBe(
				'forbidden',
			);
			// A suggestion from a supervised member cannot be approved or rejected through an app.
			const kid = await k.member('supervised');
			const draft = await run('cups.pour', kid.actor);
			if (draft.status !== 'drafted') throw new Error('expected a draft');
			await expect(k.runner.approveDraft(draft.draftId, actor)).rejects.toMatchObject({
				code: 'forbidden',
			});
			await expect(k.runner.rejectDraft(draft.draftId, actor)).rejects.toMatchObject({
				code: 'forbidden',
			});
			// Credentials are a person's own act.
			await expect(k.apiTokens.create(actor, { name: 'x', scope: 'read' })).rejects.toMatchObject({
				code: 'unauthenticated',
			});
			await expect(k.apps.list(actor)).rejects.toBeDefined();
			await expect(
				k.apps.create(actor, { name: 'x', roleId: 'member', mode: 'apply', actsFor: [] }),
			).rejects.toBeDefined();
			// The draft stays waiting.
			const left = await k.ctx.db
				.withTables<CoreTables>()
				.selectFrom('core_drafts')
				.select('status')
				.where('id', '=', draft.draftId)
				.executeTakeFirstOrThrow();
			expect(left.status).toBe('pending');
		}
	});

	it('suggest mode makes every change a draft, for the app and for a member through it', async () => {
		const leo = await k.member('admin');
		const { secret, app } = await make('admin', 'suggest', [leo.member.id]);
		const own = (await caller(secret)).actor;
		const behind = (await caller(secret, leo.member.id)).actor;
		for (const actor of [own, behind]) {
			poured.length = 0;
			for (const id of ['cups.pour', 'cups.drink', 'cups.brew']) {
				const result = await run(id, actor, { name: 'x', memberId: leo.member.id });
				expect(`${id} ${result.status}`).toBe(`${id} drafted`);
			}
			expect(poured).toEqual([]);
			// Reads still work.
			expect(await kindOf(run('cups.peek', actor))).toBe('applied');
			// Decisions say so.
			expect(decide(drink, actor, { access: k.access, critical: new Set() }).outcome).toBe('draft');
		}
		// A nested run does not slip an application through a suggest-mode app.
		expect(await kindOf(run('cups.serve', own))).toBe('drafted');
		expect(poured).toEqual([]);

		// The draft names the app and the member, and a person can approve it.
		const drafts = await k.route('core.listDrafts').call({
			query: { limit: 50 },
			actor: leo.actor,
		});
		const viaMember = drafts.find(
			(d: { proposedBy: { kind: string } }) => d.proposedBy.kind === 'member',
		);
		expect(viaMember.proposedBy.via).toMatchObject({ appId: app.id, mode: 'suggest' });
		expect(viaMember.app).toEqual({ id: app.id, name: 'Home Assistant', kind: 'connected' });
		const alone = drafts.find((d: { proposedBy: { kind: string } }) => d.proposedBy.kind === 'app');
		expect(alone.app).toEqual({ id: app.id, name: 'Home Assistant', kind: 'connected' });
		const approved = await k.runner.approveDraft(viaMember.id, leo.actor);
		expect(approved.status).toBe('applied');
	});

	it('a nested run inside an app action is decided like the app, not applied', async () => {
		const supervised = await make('supervised');
		const kid = (await caller(supervised.secret)).actor;
		// `serve` needs no approval, but the pour inside it would: the outer action cannot carry it.
		await expect(run('cups.serve', kid)).rejects.toMatchObject({ code: 'forbidden' });
		expect(poured).toEqual([]);
		const member = (await caller((await make('member')).secret)).actor;
		expect(await kindOf(run('cups.serve', member))).toBe('applied');
	});

	it('records the app and the member in the audit log', async () => {
		const leo = await k.member('member');
		const { secret, app } = await make('member', 'apply', [leo.member.id]);
		await run('cups.pour', (await caller(secret, leo.member.id)).actor);
		await run('cups.pour', (await caller(secret)).actor);
		const rows = await k.ctx.db
			.withTables<CoreTables>()
			.selectFrom('core_audit_log')
			.select('actor')
			.where('action_id', '=', 'cups.pour')
			.execute();
		const actors = rows.map((r) => JSON.parse(r.actor) as Actor);
		expect(actors).toContainEqual(
			expect.objectContaining({
				kind: 'member',
				memberId: leo.member.id,
				via: expect.objectContaining({ appId: app.id }),
			}),
		);
		expect(actors).toContainEqual(expect.objectContaining({ kind: 'app', appId: app.id }));
	});
});

describe('keys and lifecycle', () => {
	it('shows a key once, stores only its hash, and uses the famos_ prefix', async () => {
		const { secret, app } = await make('member');
		expect(secret.startsWith(API_TOKEN_PREFIX)).toBe(true);
		const rows = await k.ctx.db
			.withTables<CoreTables>()
			.selectFrom('core_app_tokens')
			.selectAll()
			.execute();
		expect(rows).toHaveLength(1);
		expect(JSON.stringify(rows)).not.toContain(secret);
		expect(JSON.stringify(await k.apps.list(admin.actor))).not.toContain(secret);
		expect(app.tokens[0]?.expiresAt).toBeNull();
	});

	it('rotates by overlap: a second key, then the first is revoked', async () => {
		const { secret, app } = await make('member');
		const second = await k.apps.createToken(admin.actor, app.id, { name: 'rotated' });
		expect(await k.apps.authenticate(secret)).not.toBeNull();
		expect(await k.apps.authenticate(second.secret)).not.toBeNull();
		await k.apps.revokeToken(admin.actor, app.id, app.tokens[0]?.id as string);
		expect(await k.apps.authenticate(secret)).toBeNull();
		expect(await k.apps.authenticate(second.secret)).not.toBeNull();
	});

	it('lets the admin set an expiry, and refuses an expired key', async () => {
		const app = await k.apps.create(admin.actor, {
			name: 'Script',
			roleId: 'member',
			mode: 'apply',
			actsFor: [],
		});
		expect(app.tokens).toEqual([]);
		const created = await k.apps.createToken(admin.actor, app.id, {
			name: 'Script',
			expiresInDays: 2,
		});
		expect(created.token.expiresAt).toBe(k.clock.now() + 2 * 86_400_000);
		expect(await k.apps.authenticate(created.secret)).not.toBeNull();
		k.clock.advance(3 * 86_400_000);
		expect(await k.apps.authenticate(created.secret)).toBeNull();
		await expect(
			k.apps.createToken(admin.actor, app.id, { name: 'x', expiresInDays: 0 }),
		).rejects.toMatchObject({ code: 'bad_request' });
	});

	it('records last use only when asked, at most hourly', async () => {
		const { secret } = await make('member');
		const found = await caller(secret);
		expect((await k.apps.list(admin.actor))[0]?.lastUsedAt).toBeNull();
		await k.apps.touch(found.tokenId);
		const first = (await k.apps.list(admin.actor))[0]?.lastUsedAt;
		expect(first).toBe(k.clock.now());
		k.clock.advance(60_000);
		await k.apps.touch(found.tokenId);
		expect((await k.apps.list(admin.actor))[0]?.lastUsedAt).toBe(first);
	});

	it('a revoked app, a revoked key and a paused app are all turned away at once', async () => {
		const leo = await k.member('member');
		const one = await make('member', 'apply', [leo.member.id]);
		await k.apps.pause(admin.actor, one.app.id);
		expect(await k.apps.authenticate(one.secret)).toBeNull();
		expect(await k.apps.authenticate(one.secret, leo.member.id)).toBeNull();
		await k.apps.resume(admin.actor, one.app.id);
		expect(await k.apps.authenticate(one.secret)).not.toBeNull();
		await k.apps.revoke(admin.actor, one.app.id);
		expect(await k.apps.authenticate(one.secret)).toBeNull();
		await expect(k.apps.resume(admin.actor, one.app.id)).rejects.toMatchObject({
			code: 'conflict',
		});
		await expect(
			k.apps.createToken(admin.actor, one.app.id, { name: 'late' }),
		).rejects.toMatchObject({ code: 'conflict' });
	});

	it('a changed role or mode applies on the next request', async () => {
		const { secret, app } = await make('member');
		expect(await kindOf(run('cups.pour', (await caller(secret)).actor))).toBe('applied');
		await k.apps.update(admin.actor, app.id, { mode: 'suggest' });
		expect(await kindOf(run('cups.pour', (await caller(secret)).actor))).toBe('drafted');
		await k.apps.update(admin.actor, app.id, { mode: 'apply', roleId: 'guest' });
		expect(await codeOf(run('cups.pour', (await caller(secret)).actor))).toBe('forbidden');
	});

	it('only an admin who signed in with a password manages apps', async () => {
		const member = await k.member('member');
		await expect(k.apps.list(member.actor)).rejects.toMatchObject({ code: 'forbidden' });
		const pinned: Actor = { ...admin.actor, pin: true };
		await expect(k.apps.list(pinned)).rejects.toMatchObject({ code: 'forbidden' });
		await expect(
			k.apps.create(pinned, { name: 'x', roleId: 'member', mode: 'apply', actsFor: [] }),
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(k.apps.list({ kind: 'system', source: 'job' })).rejects.toBeDefined();
		await expect(
			k.apps.list({ kind: 'ai', mode: 'agent', source: 'mcp', onBehalfOf: admin.actor.memberId }),
		).rejects.toBeDefined();
		expect(await k.apps.list(admin.actor)).toEqual([]);
	});

	it('refuses unknown roles and members, and a role that an app still uses cannot be deleted', async () => {
		await expect(
			k.apps.create(admin.actor, { name: 'x', roleId: 'role_nope', mode: 'apply', actsFor: [] }),
		).rejects.toMatchObject({ code: 'bad_request' });
		await expect(
			k.apps.create(admin.actor, {
				name: 'x',
				roleId: 'member',
				mode: 'apply',
				actsFor: ['member_nope'],
			}),
		).rejects.toMatchObject({ code: 'bad_request' });
		await expect(
			k.apps.create(admin.actor, { name: ' ', roleId: 'member', mode: 'apply', actsFor: [] }),
		).rejects.toMatchObject({ code: 'bad_request' });
		const made = await k.runner.invoke<{ id: string }>(
			'core.createRole',
			{ name: 'Helper', base: 'member', overrides: {} },
			admin.actor,
		);
		if (made.status !== 'applied') throw new Error('role not created');
		const { app } = await make(made.output.id);
		await expect(
			k.runner.invoke('core.deleteRole', { id: made.output.id }, admin.actor),
		).rejects.toMatchObject({ code: 'conflict' });
		await k.apps.revoke(admin.actor, app.id);
		const gone = await k.runner.invoke('core.deleteRole', { id: made.output.id }, admin.actor);
		expect(gone.status).toBe('applied');
	});

	it('the unknown key, a personal key and a wrong prefix are not apps', async () => {
		await make('member');
		expect(await k.apps.authenticate('famos_nope')).toBeNull();
		expect(await k.apps.authenticate('nope')).toBeNull();
		expect(await k.apps.authenticate(null)).toBeNull();
		expect(await k.apps.authenticate(`famos_${'x'.repeat(200)}`)).toBeNull();
		const personal = await k.apiTokens.create(admin.actor, { name: 'mine', scope: 'read' });
		expect(await k.apps.authenticate(personal.secret)).toBeNull();
	});
});

describe('personal keys (MCP) are unchanged', () => {
	it('an old key still resolves to its member, and an app key never does', async () => {
		const personal = await k.apiTokens.create(admin.actor, { name: 'mine', scope: 'read_write' });
		const found = await k.apiTokens.authenticate(personal.secret);
		expect(found?.member.id).toBe(admin.member.id);
		expect(found?.token.scope).toBe('read_write');
		const { secret } = await make('admin');
		expect(await k.apiTokens.authenticate(secret)).toBeNull();
		// Revoking an app leaves personal keys alone, and the reverse.
		await k.apps.revoke(admin.actor, (await k.apps.list(admin.actor))[0]?.id as string);
		expect(await k.apiTokens.authenticate(personal.secret)).not.toBeNull();
	});

	it('the AI agent actor still gets the same decisions as before', async () => {
		const agent: Actor = {
			kind: 'ai',
			mode: 'agent',
			source: 'mcp',
			sourceId: 'api_token_1',
			onBehalfOf: admin.member.id as never,
			roleId: 'admin',
			scope: 'read_write',
		};
		expect(await kindOf(run('cups.pour', agent))).toBe('drafted');
		// The agent reads only view-level things, as before.
		expect(await codeOf(run('cups.peek', agent))).toBe('forbidden');
		const readOnly: Actor = { ...agent, scope: 'read' };
		expect(await codeOf(run('cups.pour', readOnly))).toBe('forbidden');
	});
});

describe('idempotency is kept per principal', () => {
	it('one key from the app, the app for a member and the member never meets', async () => {
		const leo = await k.member('member');
		const { secret } = await make('member', 'apply', [leo.member.id]);
		const own = (await caller(secret)).actor;
		const behind = (await caller(secret, leo.member.id)).actor;
		const send = (actor: Actor) =>
			k.runner.invoke('cups.pour', { name: 'once' }, actor, { idempotencyKey: 'same-key' });
		for (const actor of [own, behind, leo.actor]) {
			const before = poured.length;
			await send(actor);
			expect(poured.length).toBe(before + 1);
			// The same principal asking again gets the stored answer and changes nothing.
			await send(actor);
			expect(poured.length).toBe(before + 1);
		}
		expect(poured).toEqual(['once', 'once', 'once']);
	});

	it('a second app does not replay the first one', async () => {
		const first = await make('member');
		const second = await make('member');
		const a = (await caller(first.secret)).actor;
		const b = (await caller(second.secret)).actor;
		await k.runner.invoke('cups.pour', { name: 'a' }, a, { idempotencyKey: 'k' });
		await k.runner.invoke('cups.pour', { name: 'b' }, b, { idempotencyKey: 'k' });
		expect(poured).toEqual(['a', 'b']);
	});
});

describe('after a restore', () => {
	it('pauses every live app and keeps revoked ones revoked', async () => {
		const live = await make('member');
		const revoked = await make('member');
		await k.apps.revoke(admin.actor, revoked.app.id);
		await k.reconcileRestore(null);
		const apps = await k.apps.list(admin.actor);
		const state = (id: string) => apps.find((a) => a.id === id);
		expect(state(live.app.id)?.pausedAt).not.toBeNull();
		expect(await k.apps.authenticate(live.secret)).toBeNull();
		await k.apps.resume(admin.actor, live.app.id);
		expect(await k.apps.authenticate(live.secret)).not.toBeNull();
		expect(await k.apps.authenticate(revoked.secret)).toBeNull();
	});
});
