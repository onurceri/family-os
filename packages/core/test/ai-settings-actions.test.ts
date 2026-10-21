import { type Actor, isFamosError, type MemberId } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreTables } from '../src/tables.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

const sneaky = defineTestExtension({ id: 'sneaky' });

let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
let member: Awaited<ReturnType<TestKernel['member']>>;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [sneaky] });
	admin = await k.member('admin');
	member = await k.member('member');
});
afterEach(() => k.close());

const auditOf = (actionId: string) =>
	k.ctx.db
		.withTables<CoreTables>()
		.selectFrom('core_audit_log')
		.select(['action_id', 'outcome', 'target', 'actor'])
		.where('action_id', '=', actionId)
		.execute();

const invoke = (id: string, input: unknown, actor: Actor = admin.actor) =>
	k.runner.invoke(id, input, actor);

async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		const result = (await promise) as { status?: string };
		return result.status ?? 'ok';
	} catch (error) {
		if (isFamosError(error)) return error.code;
		throw error;
	}
}

const appActor: Actor = {
	kind: 'app',
	appId: 'app_0198c2a0-0000-7000-8000-000000000001',
	roleId: 'admin',
	mode: 'apply',
};
const aiFor = (memberId: MemberId): Actor => ({
	kind: 'ai',
	mode: 'conversation',
	source: 'assistant',
	onBehalfOf: memberId,
	roleId: 'admin',
});
const displayActor: Actor = {
	kind: 'display',
	deviceId: 'device_0198c2a0-0000-7000-8000-000000000001',
	capabilities: [],
	showNames: false,
};

async function newProvider(baseUrl = 'https://llm.example.com/v1') {
	const result = await invoke('core.addAiProvider', {
		name: 'Home model',
		kind: 'openai-compatible',
		baseUrl,
	});
	if (result.status !== 'applied') throw new Error('expected a provider');
	return result.output as { id: string; hasKey: boolean };
}

const model = (providerId: string) => ({ providerId, model: 'small' });
const roles = (providerId: string) => ({
	fast: model(providerId),
	vision: null,
	smart: model(providerId),
	transcribe: null,
	embed: null,
});

describe('AI settings are actions', () => {
	it('applies every change for an admin and names the provider in the audit log', async () => {
		const provider = await newProvider();
		expect(provider.hasKey).toBe(false);
		expect(await auditOf('core.addAiProvider')).toMatchObject([
			{ outcome: 'applied', target: null },
		]);

		const renamed = await invoke('core.updateAiProvider', {
			providerId: provider.id,
			name: 'Attic server',
		});
		expect(renamed).toMatchObject({
			status: 'applied',
			output: { provider: { id: provider.id, name: 'Attic server' }, keyDropped: false },
		});
		const set = await invoke('core.setAiRoles', roles(provider.id));
		expect(set.status).toBe('applied');
		expect(await k.ai.roles()).toMatchObject({ smart: model(provider.id) });

		const limits = { monthlyCostLimit: 5, monthlyCallLimit: 200 };
		expect(await invoke('core.setAiLimits', limits)).toMatchObject({
			status: 'applied',
			output: limits,
		});
		expect(await k.ai.limits()).toEqual(limits);

		const privacy = { sendFiles: false, sendPeople: true, sendVoice: false, zeroRetention: true };
		await invoke('core.setAiPrivacy', privacy);
		expect(await k.ai.privacy()).toEqual(privacy);

		await invoke('core.setAiSwitches', { enabled: false, off: ['inbox.read', 'assistant.chat'] });
		// Kept sorted, once each.
		expect(await k.ai.switches()).toEqual({
			enabled: false,
			off: ['assistant.chat', 'inbox.read'],
		});

		await invoke('core.deleteAiProvider', { providerId: provider.id });
		expect((await k.ai.get()).providers).toEqual([]);
		// The jobs that used the provider are unset again.
		expect(await k.ai.roles()).toMatchObject({ fast: null, smart: null });

		for (const id of ['core.updateAiProvider', 'core.deleteAiProvider'])
			expect(await auditOf(id)).toMatchObject([{ outcome: 'applied', target: provider.id }]);
		for (const id of [
			'core.setAiRoles',
			'core.setAiLimits',
			'core.setAiPrivacy',
			'core.setAiSwitches',
		]) {
			const rows = await auditOf(id);
			expect(rows).toMatchObject([{ outcome: 'applied', target: null }]);
			// Who did it, never what was sent.
			expect(JSON.parse(rows[0]?.actor ?? '{}')).toEqual(admin.actor);
		}
	});

	it('refuses a bad provider, role or address without changing anything', async () => {
		const provider = await newProvider();
		expect(
			await codeOf(
				invoke('core.setAiRoles', roles('ai_provider_00000000-0000-7000-8000-000000000000')),
			),
		).toBe('bad_request');
		expect(await codeOf(invoke('core.deleteAiProvider', { providerId: 'ai_provider_nope' }))).toBe(
			'not_found',
		);
		expect(
			await codeOf(
				invoke('core.updateAiProvider', { providerId: provider.id, baseUrl: 'ftp://x' }),
			),
		).toBe('bad_request');
		// The server's own provider is changed in the configuration, not here.
		expect(await codeOf(invoke('core.deleteAiProvider', { providerId: 'ai_provider_env' }))).toBe(
			'bad_request',
		);
		expect((await k.ai.get()).providers).toHaveLength(1);
		expect(await k.ai.roles()).toMatchObject({ fast: null });
	});

	it('refuses a member, a supervised child, an app, the AI and a display', async () => {
		const provider = await newProvider();
		const child = await k.member('supervised');
		const refused = [
			member.actor,
			child.actor,
			appActor,
			aiFor(admin.member.id as MemberId),
			displayActor,
		];
		const attempts: [string, unknown][] = [
			['core.addAiProvider', { name: 'X', kind: 'ollama' }],
			['core.updateAiProvider', { providerId: provider.id, name: 'X' }],
			['core.deleteAiProvider', { providerId: provider.id }],
			['core.setAiRoles', roles(provider.id)],
			['core.setAiLimits', { monthlyCostLimit: 1, monthlyCallLimit: null }],
			[
				'core.setAiPrivacy',
				{ sendFiles: false, sendPeople: false, sendVoice: false, zeroRetention: false },
			],
			['core.setAiSwitches', { enabled: false, off: [] }],
		];
		for (const actor of refused)
			for (const [id, input] of attempts)
				expect(await codeOf(invoke(id, input, actor)), `${id} as ${actor.kind}`).toBe('forbidden');
		// The extension's own context is held to the same rule.
		expect(
			await codeOf(
				k
					.contextFor('sneaky')
					.actions.invoke(
						'core.setAiSwitches',
						{ enabled: false, off: [] },
						{ kind: 'ai', mode: 'agent', source: 'sneaky' },
					),
			),
		).toBe('forbidden');
		// Nothing changed, nothing was drafted or audited.
		expect((await k.ai.get()).providers).toMatchObject([{ id: provider.id, name: 'Home model' }]);
		expect(await k.ai.switches()).toEqual({ enabled: true, off: [] });
		for (const [id] of attempts.slice(1)) expect(await auditOf(id)).toEqual([]);
		expect(
			await k.ctx.db.withTables<CoreTables>().selectFrom('core_drafts').select('id').execute(),
		).toEqual([]);
	});

	it('does not let a PIN sign-in change them either', async () => {
		const pin: Actor = { ...admin.actor, pin: true };
		expect(await codeOf(invoke('core.setAiSwitches', { enabled: false, off: [] }, pin))).toBe(
			'forbidden',
		);
		expect(await k.ai.switches()).toEqual({ enabled: true, off: [] });
	});

	it('drops the stored key when the address changes, and keeps it for any other change', async () => {
		const provider = await newProvider();
		await k.ai.setApiKey(provider.id, 'sk-secret-key');
		expect((await k.ai.get()).providers[0]).toMatchObject({ hasKey: true, keyReadable: true });

		const renamed = await invoke('core.updateAiProvider', {
			providerId: provider.id,
			name: 'Renamed',
		});
		expect(renamed).toMatchObject({ output: { keyDropped: false, provider: { hasKey: true } } });

		const sameAddress = await invoke('core.updateAiProvider', {
			providerId: provider.id,
			baseUrl: 'https://llm.example.com/v1/',
		});
		expect(sameAddress).toMatchObject({
			output: { keyDropped: false, provider: { hasKey: true } },
		});

		const moved = await invoke('core.updateAiProvider', {
			providerId: provider.id,
			baseUrl: 'https://elsewhere.example.org/v1',
		});
		expect(moved).toMatchObject({
			status: 'applied',
			output: {
				keyDropped: true,
				provider: { hasKey: false, baseUrl: 'https://elsewhere.example.org/v1' },
			},
		});
		expect((await k.ai.get()).providers[0]).toMatchObject({ hasKey: false });
		expect(await k.ai.resolve(provider.id)).toMatchObject({ apiKey: null });
		// A provider that never had a key has none to drop.
		const bare = await newProvider('https://bare.example.com/v1');
		expect(
			await invoke('core.updateAiProvider', {
				providerId: bare.id,
				baseUrl: 'https://bare.example.net/v1',
			}),
		).toMatchObject({ output: { keyDropped: false } });
	});

	it('never takes or returns a key, so no answer kept for a replay holds one', async () => {
		const made = await k.runner.invoke(
			'core.addAiProvider',
			{ name: 'Cloud', kind: 'openrouter', apiKey: 'sk-should-be-ignored' },
			admin.actor,
			{ idempotencyKey: 'add-cloud' },
		);
		expect(made.status).toBe('applied');
		const { id } = (made as { output: { id: string } }).output;
		expect((await k.ai.get()).providers).toMatchObject([{ id, hasKey: false }]);
		await k.ai.setApiKey(id, 'sk-real-secret');
		await invoke('core.updateAiProvider', { providerId: id, name: 'Cloud 2' });
		const kept = JSON.stringify(
			await k.ctx.db
				.withTables<CoreTables>()
				.selectFrom('core_idempotency')
				.select('response')
				.execute(),
		);
		const audit = JSON.stringify(
			await k.ctx.db.withTables<CoreTables>().selectFrom('core_audit_log').selectAll().execute(),
		);
		for (const text of [kept, audit]) {
			expect(text).not.toContain('sk-real-secret');
			expect(text).not.toContain('sk-should-be-ignored');
		}
	});

	it('is never proposed to the AI', () => {
		const ids = k.ctx.actions
			.aiCatalog({ actor: aiFor(admin.member.id as MemberId) })
			.map((a) => a.id);
		expect(
			ids.filter((id) => /^core\.(add|update|delete)AiProvider$|^core\.setAi/.test(id)),
		).toEqual([]);
	});

	it('tells the people who manage AI when the models changed, and only then', async () => {
		const heard: string[] = [];
		k.bus.on({ name: 'core.aiModels.changed' } as never, () => {
			heard.push('models');
		});
		const provider = await newProvider();
		expect(heard).toEqual([]);
		await invoke('core.setAiRoles', roles(provider.id));
		await invoke('core.updateAiProvider', { providerId: provider.id, name: 'Other' });
		await invoke('core.setAiLimits', { monthlyCostLimit: null, monthlyCallLimit: null });
		await invoke('core.deleteAiProvider', { providerId: provider.id });
		expect(heard).toEqual(['models', 'models', 'models']);
		// A refused change tells nobody.
		await invoke('core.setAiRoles', roles('ai_provider_x'), member.actor).catch(() => {});
		expect(heard).toHaveLength(3);
	});
});
