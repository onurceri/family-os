import type { Mention } from '@famos/sdk';
import { repoTranslate, resolveMentions, SHARE_AI, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recipeLines, sourceUrlOf } from '../src/server/understand.ts';
import { applied, createKernel, type Person, person } from './support.ts';

let k: TestKernel;
let admin: Person;

const of = (kind: string) => (m: Omit<Mention, 'kind'>) => ({ kind, ...m });
const recipe = of('kitchen.recipe');
const meal = of('kitchen.meal');
const mealOff = of('kitchen.mealOff');

beforeEach(async () => {
	k = await createKernel({ translate: repoTranslate() });
	admin = await person(k, 'admin', 'Mara');
});
afterEach(() => k.close());

describe('a recipe', () => {
	it('keeps the ingredients and the steps apart, and the one address the message shows', async () => {
		const [out] = await resolveMentions(
			k,
			'kitchen.recipe',
			[
				recipe({
					title: 'Lentil soup',
					lines: ['1 cup red lentils', '1 onion', '1. Fry the onion.', '2. Simmer for 30 minutes.'],
					quantity: '4',
					amount: '40',
					tags: ['soup', 'soup'],
				}),
			],
			{ text: 'Lentil soup from https://example.org/lentil-soup. Serves 4.' },
		);
		expect(out).toEqual({
			propose: {
				actionId: 'kitchen.createRecipe',
				input: {
					title: 'Lentil soup',
					ingredients: ['1 cup red lentils', '1 onion'],
					steps: ['Fry the onion.', 'Simmer for 30 minutes.'],
					servings: '4',
					totalMinutes: 40,
					tags: ['soup'],
					sourceUrl: 'https://example.org/lentil-soup',
				},
				subject: 'Lentil soup',
				from: [0],
			},
		});
		if (!out || !('propose' in out)) throw new Error('expected a suggestion');
		expect((await k.runner.invoke(out.propose.actionId, out.propose.input, SHARE_AI)).status).toBe(
			'drafted',
		);
	});

	it('leaves out a recipe it has, and a dish without a recipe', async () => {
		await applied(
			k,
			'kitchen.createRecipe',
			{ title: 'Lentil soup', ingredients: ['lentils'] },
			admin.actor,
		);
		const out = await resolveMentions(k, 'kitchen.recipe', [
			recipe({ title: 'lentil soup', lines: ['lentils'] }),
			recipe({ title: 'Pancakes' }),
		]);
		expect(out).toEqual([
			{ refuse: { reason: 'already', subject: 'lentil soup', from: [0] } },
			{ refuse: { reason: 'incomplete', subject: 'Pancakes', from: [1] } },
		]);
	});

	it('reads lines and addresses by their shape alone', () => {
		expect(recipeLines(['1.5 kg flour', '2) Knead', 'Rest for an hour'])).toEqual({
			ingredients: ['1.5 kg flour'],
			steps: ['Knead', 'Rest for an hour'],
		});
		expect(sourceUrlOf('See https://a.example/x and https://b.example/y')).toBeNull();
		expect(sourceUrlOf('From (https://a.example/x).')).toBe('https://a.example/x');
		expect(sourceUrlOf(null)).toBeNull();
	});
});

describe('the meal plan', () => {
	it('plans a dish on its day, a saved recipe by its name, dinner when no meal is said', async () => {
		const soup = await applied<{ id: string }>(
			k,
			'kitchen.createRecipe',
			{ title: 'Lentil soup', ingredients: ['lentils'] },
			admin.actor,
		);
		const out = await resolveMentions(
			k,
			'kitchen.meal',
			[
				meal({ title: 'Pancakes', variant: 'breakfast', date: { text: 'Sunday', weekday: 7 } }),
				meal({ title: 'Lentil soup', date: { text: 'tomorrow', inDays: 1 } }),
			],
			{ text: 'Pancakes for breakfast on Sunday, lentil soup tomorrow' },
		);
		expect(out).toEqual([
			{
				propose: {
					actionId: 'kitchen.addToMealPlan',
					input: { date: '2026-10-11', slot: 'breakfast', title: 'Pancakes' },
					subject: 'Pancakes',
					uncertain: ['date'],
					from: [0],
				},
			},
			{
				propose: {
					actionId: 'kitchen.addToMealPlan',
					input: { date: '2026-10-07', slot: 'dinner', recipeId: soup.id, title: '' },
					subject: 'Lentil soup',
					from: [1],
				},
			},
		]);
	});

	it('leaves out a meal that is already planned, and needs a day', async () => {
		await applied(
			k,
			'kitchen.addToMealPlan',
			{ date: '2026-10-07', slot: 'dinner', title: 'Pizza' },
			admin.actor,
		);
		const out = await resolveMentions(k, 'kitchen.meal', [
			meal({ title: 'pizza', variant: 'dinner', date: { text: 'tomorrow', inDays: 1 } }),
			meal({ title: 'Tacos' }),
		]);
		expect(out).toEqual([
			{ refuse: { reason: 'already', subject: 'pizza', from: [0] } },
			{ refuse: { reason: 'incomplete', subject: 'Tacos', from: [1] } },
		]);
	});

	it('takes off the planned meal the message names, and nothing it does not', async () => {
		const fish = await applied<{ id: string }>(
			k,
			'kitchen.addToMealPlan',
			{ date: '2026-10-09', slot: 'dinner', title: 'Fish' },
			admin.actor,
		);
		await applied(
			k,
			'kitchen.addToMealPlan',
			{ date: '2026-10-08', slot: 'dinner', title: 'Pancakes' },
			admin.actor,
		);
		await applied(
			k,
			'kitchen.addToMealPlan',
			{ date: '2026-10-10', slot: 'lunch', title: 'Fish' },
			admin.actor,
		);
		const out = await resolveMentions(
			k,
			'kitchen.mealOff',
			[
				mealOff({ target: 'Fish', date: { text: 'Friday', weekday: 5 } }),
				mealOff({ target: 'Fish' }),
				// Replay: a label that names another meal than the one planned.
				mealOff({ target: 'Lentil soup', date: { text: 'Thursday', weekday: 4 } }),
			],
			{ text: 'No fish on Friday after all; no lentil soup on Thursday either' },
		);
		expect(out).toEqual([
			{
				propose: {
					actionId: 'kitchen.removeMealPlanEntry',
					input: { id: fish.id, label: 'Fish' },
					subject: 'Fish',
					targetTitle: 'Fish',
					from: [0],
				},
			},
			{ refuse: { reason: 'ambiguous', subject: 'Fish', from: [1] } },
			{ refuse: { reason: 'unknown', subject: 'Lentil soup', from: [2] } },
		]);
		const [first] = out;
		if (!first || !('propose' in first)) throw new Error('expected a suggestion');
		const drafted = await k.runner.invoke(first.propose.actionId, first.propose.input, SHARE_AI);
		expect(drafted.status).toBe('drafted');
	});
});
