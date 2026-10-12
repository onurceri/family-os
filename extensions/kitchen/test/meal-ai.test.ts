import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AI, applied, createKernel, person } from './support.ts';

let k: Awaited<ReturnType<typeof createKernel>>;
beforeEach(async () => {
	k = await createKernel();
});
afterEach(() => k.close());

describe('removing a planned meal as the AI', () => {
	it('is offered to the AI and becomes a draft that removes the meal when approved', async () => {
		expect(k.ctx.actions.aiCatalog().map((a) => a.id)).toContain('kitchen.removeMealPlanEntry');
		const admin = await person(k, 'admin', 'Deniz');
		const meal = await applied<{ id: string }>(
			k,
			'kitchen.addToMealPlan',
			{ date: '2026-10-08', slot: 'dinner', title: 'Pancakes' },
			admin.actor,
		);

		const result = await k.runner.invoke('kitchen.removeMealPlanEntry', { id: meal.id }, AI);
		expect(result.status).toBe('drafted');
		const plan = async () =>
			applied<{ meals: unknown[] }>(
				k,
				'kitchen.mealPlan',
				{ from: '2026-10-08', days: 1 },
				admin.actor,
			);
		expect((await plan()).meals).toHaveLength(1);
		if (result.status !== 'drafted') throw new Error('expected a draft');
		await k.runner.approveDraft(result.draftId, admin.actor);
		expect((await plan()).meals).toHaveLength(0);
	});
});
