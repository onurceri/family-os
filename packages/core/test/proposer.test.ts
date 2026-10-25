import type { Actor, MemberId } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notesExtension, whoShared } from './fixtures.ts';
import { createTestKernel, type TestKernel } from './harness.ts';

let k: TestKernel;
beforeEach(async () => {
	whoShared.length = 0;
	k = await createTestKernel({ extensions: [notesExtension] });
});
afterEach(() => k.close());

describe('uow.proposer', () => {
	it('is the actor on a direct run', async () => {
		const { actor } = await k.member('member');
		await k.runner.invoke('notes.share', { body: 'x' }, actor);
		expect(whoShared).toEqual([{ actor, proposer: actor }]);
	});

	it('is the person who suggested it when an approver applies the draft', async () => {
		const { actor: kid } = await k.member('supervised');
		const { actor: admin } = await k.member('admin');
		const drafted = await k.runner.invoke('notes.share', { body: 'x' }, kid);
		if (drafted.status !== 'drafted') throw new Error('expected a draft');
		await k.runner.approveDraft(drafted.draftId, admin);
		expect(whoShared).toEqual([{ actor: admin, proposer: kid }]);
	});

	it('is the AI acting for the member when the AI suggested it', async () => {
		const { actor: admin } = await k.member('admin');
		const { member } = await k.member('supervised');
		const ai: Actor = {
			kind: 'ai',
			mode: 'conversation',
			source: 'assistant',
			onBehalfOf: member.id as MemberId,
			roleId: 'supervised',
		};
		const drafted = await k.runner.invoke('notes.share', { body: 'x' }, ai);
		if (drafted.status !== 'drafted') throw new Error('expected a draft');
		await k.runner.approveDraft(drafted.draftId, admin);
		expect(whoShared).toEqual([{ actor: admin, proposer: ai }]);
	});
});
