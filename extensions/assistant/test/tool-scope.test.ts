import type { AiActionInfo } from '@famos/sdk';
import { describe, expect, it } from 'vitest';
import { CHANGE_FALLBACK_TOPICS, scopeTools, scopeTopics } from '../src/server/tool-scope.ts';
import type { AssistantTool } from '../src/server/tools.ts';

const tool = (actionId: string, kind: 'read' | 'draft'): AssistantTool => ({
	actionId,
	kind,
	info: { id: actionId } as AiActionInfo,
});

const ALL = [
	tool('calendar.findEvents', 'read'),
	tool('calendar.createEvent', 'draft'),
	tool('lists.openTasks', 'read'),
	tool('lists.addTask', 'draft'),
	tool('lists.addShoppingItems', 'draft'),
	tool('kitchen.mealPlan', 'read'),
	tool('kitchen.addToMealPlan', 'draft'),
	tool('vehicles.listVehicles', 'read'),
	tool('vehicles.addService', 'draft'),
	tool('core.today', 'read'),
	tool('core.mySuggestions', 'read'),
	tool('core.addMemory', 'draft'),
];

const ids = (tools: readonly AssistantTool[]) => tools.map((t) => t.actionId);

describe('the topics of a change', () => {
	it('are the ones named, then those of the answer before it', () => {
		expect(scopeTopics(['meals'], ['calendar'])).toEqual(['meals', 'calendar']);
		expect(scopeTopics([], ['calendar'])).toEqual(['calendar']);
	});

	it('fall back to the calendar, tasks and shopping when nothing says more', () => {
		expect(scopeTopics([], [])).toEqual([...CHANGE_FALLBACK_TOPICS]);
		expect(CHANGE_FALLBACK_TOPICS).toEqual(['calendar', 'tasks', 'shopping']);
	});
});

describe('the tools of a change', () => {
	it('are the draft and read tools of its topics, and core reads', () => {
		expect(ids(scopeTools(ALL, 'change', ['calendar']))).toEqual([
			'calendar.findEvents',
			'calendar.createEvent',
			'core.today',
			'core.mySuggestions',
		]);
	});

	it('take both of the two kinds of list from the one area that keeps them', () => {
		expect(ids(scopeTools(ALL, 'change', ['tasks']))).toEqual(
			expect.arrayContaining(['lists.openTasks', 'lists.addTask', 'lists.addShoppingItems']),
		);
	});

	it('leave out other areas and the note to remember', () => {
		const offered = ids(scopeTools(ALL, 'change', ['meals']));
		expect(offered).toEqual([
			'kitchen.mealPlan',
			'kitchen.addToMealPlan',
			'core.today',
			'core.mySuggestions',
		]);
	});

	it('offer the note to remember when the person asked to remember', () => {
		expect(ids(scopeTools(ALL, 'remember', ['calendar']))).toContain('core.addMemory');
	});

	it('are a handful with the fallback topics, not every tool', () => {
		const offered = scopeTools(ALL, 'change', scopeTopics([], []));
		expect(offered.length).toBeLessThan(ALL.length);
		expect(ids(offered)).not.toContain('vehicles.addService');
	});

	it('are every tool for anything else', () => {
		expect(scopeTools(ALL, 'other', ['calendar'])).toEqual(ALL);
		expect(scopeTools(ALL, 'ask', ['calendar'])).toEqual(ALL);
	});
});
