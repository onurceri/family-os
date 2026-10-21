import { type MemberId, systemActor } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestKernel, type TestKernel } from '../src/index.ts';

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel();
});
afterEach(() => k.close());

describe('the models changed', () => {
	it('brings family search in line after the action commits, as an area change does', async () => {
		const admin = await k.member('admin');
		const asAi = {
			kind: 'ai',
			mode: 'conversation',
			source: 'assistant',
			onBehalfOf: admin.member.id as MemberId,
			roleId: 'admin',
		} as const;
		const offered = () => k.ctx.actions.aiReadTools({ actor: asAi }).map((tool) => tool.id);

		await k.reconcileSearch();
		expect(offered()).not.toContain('core.searchFamily');

		// An embedding model is set; search is offered once the role is chosen in the settings.
		k.llm.embedModel = 'fake:embedder';
		expect(offered()).not.toContain('core.searchFamily');
		const provider = await k.runner.invoke<{ id: string }>(
			'core.addAiProvider',
			{ name: 'Home', kind: 'ollama' },
			admin.actor,
		);
		if (provider.status !== 'applied') throw new Error('expected a provider');
		expect(offered()).not.toContain('core.searchFamily');
		await k.runner.invoke(
			'core.setAiRoles',
			{
				fast: null,
				vision: null,
				smart: null,
				transcribe: null,
				embed: { providerId: provider.output.id, model: 'e' },
			},
			admin.actor,
		);
		expect(offered()).toContain('core.searchFamily');

		// Taking the model away follows the same way.
		k.llm.embedModel = null;
		await k.runner
			.invoke('core.deleteAiProvider', { providerId: provider.output.id }, systemActor('test'))
			.catch(() => undefined);
		await k.runner.invoke('core.deleteAiProvider', { providerId: provider.output.id }, admin.actor);
		expect(offered()).not.toContain('core.searchFamily');
	});
});
