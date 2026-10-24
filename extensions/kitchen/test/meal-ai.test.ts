import { repoTranslate } from '@famos/testing';
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

		const result = await k.runner.invoke(
			'kitchen.removeMealPlanEntry',
			// The AI names the meal in the person's words.
			{ id: meal.id, label: 'pancakes' },
			AI,
		);
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

	it('names the meal, its slot and its day, and refuses a label that names another meal', async () => {
		const admin = await person(k, 'admin', 'Deniz');
		const meal = await applied<{ id: string }>(
			k,
			'kitchen.addToMealPlan',
			{ date: '2026-10-08', slot: 'dinner', title: 'Pancakes' },
			admin.actor,
		);
		await expect(
			k.runner.invoke('kitchen.removeMealPlanEntry', { id: meal.id, label: 'Lentil soup' }, AI),
		).rejects.toMatchObject({ code: 'conflict' });
		const ok = await k.runner.invoke(
			'kitchen.removeMealPlanEntry',
			{ id: meal.id, label: 'Pancakes' },
			AI,
		);
		expect(ok.status).toBe('drafted');
		const target = await k.registry.actions.get('kitchen.removeMealPlanEntry')?.targetTitle?.(
			{
				db: k.ctx.db,
				family: k.ctx.family,
				translate: repoTranslate(),
				vocabulary: k.ctx.vocabulary,
				now: k.clock.now(),
			},
			{ id: meal.id },
		);
		expect(target).toBe('Pancakes · dinner, Thu, Oct 8');
	});

	it('keeps the meal’s name on the card after the meal is gone', async () => {
		const admin = await person(k, 'admin', 'Deniz');
		const meal = await applied<{ id: string }>(
			k,
			'kitchen.addToMealPlan',
			{ date: '2026-10-08', slot: 'dinner', title: 'Pancakes' },
			admin.actor,
		);
		const result = await k.runner.invoke(
			'kitchen.removeMealPlanEntry',
			{ id: meal.id, label: 'pancakes' },
			AI,
		);
		if (result.status !== 'drafted') throw new Error('expected a draft');
		await k.runner.approveDraft(result.draftId, admin.actor);

		// The card reads the stored label; the meal itself no longer exists to be looked up.
		const [draft] = (await k.route('core.listDrafts').call({
			query: { limit: 5 },
			actor: admin.actor,
		})) as { status: string; input: { label?: string } }[];
		expect(draft?.status).toBe('applied');
		expect(draft?.input.label).toMatch(/^Pancakes · /);
	});
});
