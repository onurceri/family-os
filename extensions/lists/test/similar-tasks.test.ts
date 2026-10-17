import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import lists from '../src/server/index.ts';

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [lists] });
});
afterEach(() => k.close());

const ai = { kind: 'ai', mode: 'share', source: 'inbox' } as const;

// Found in use: "Pay 18 EUR" was held back as already there because "Pay 10 EUR for the bus" says
// the same words.
describe('tasks that differ in a number', () => {
	it('are different tasks, while the same amount is a duplicate', async () => {
		const { actor } = await k.member('admin');
		await k.runner.invoke('lists.addTask', { title: 'Pay 10 EUR for the bus' }, actor);
		const mayExist = async (title: string) => {
			const result = await k.runner.invoke('lists.addTask', { title }, ai);
			if (result.status !== 'drafted') throw new Error('expected a draft');
			const drafts = (await k.route('core.listDrafts').call({ actor, query: { limit: 20 } })) as {
				id: string;
				mayExist: boolean;
			}[];
			return drafts.find((d) => d.id === result.draftId)?.mayExist;
		};
		expect(await mayExist('Pay 18 EUR')).toBe(false);
		expect(await mayExist('Pay 10 EUR')).toBe(true);
	});
});
