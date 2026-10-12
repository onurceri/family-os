import type { AiActionInfo } from '@famos/sdk';
import { repoVocabulary } from '@famos/testing';
import { describe, expect, it } from 'vitest';
import { type AssistantTool, narrow } from '../src/server/tools.ts';

const words = repoVocabulary();

const tool = (actionId: string, changes = false): AssistantTool => ({
	actionId,
	kind: 'read',
	info: {
		id: actionId,
		title: actionId,
		description: actionId,
		inputSchema: changes ? { type: 'object', properties: { id: {} } } : { type: 'object' },
	} satisfies AiActionInfo,
});

describe('tool narrowing in a conversation', () => {
	const crowded = [
		...Array.from({ length: 12 }, (_, i) => tool(`calendar.change${i}`, true)),
		...Array.from({ length: 20 }, (_, i) => tool(`lists.add${i}`)),
	];
	const calendarTools = (picked: AssistantTool[]) =>
		picked.filter((t) => t.actionId.startsWith('calendar'));

	it('can cut the tools that change an event when the follow-up names no area', () => {
		expect(calendarTools(narrow(crowded, 'Yes, move it to 18:00.', words))).toHaveLength(4);
	});

	it('keeps the tools of the areas the conversation already worked in', () => {
		const picked = narrow(crowded, 'Yes, move it to 18:00.', words, new Set(['calendar']));
		expect(calendarTools(picked)).toHaveLength(12);
	});

	it('looks at what was said lately, not only the last message', () => {
		const picked = narrow(
			crowded,
			'What is on the calendar tomorrow?\nYes, move it to 18:00.',
			words,
		);
		expect(calendarTools(picked)).toHaveLength(12);
	});
});

describe('the read tools an action sends the model to', () => {
	const as = (kind: 'read' | 'draft', actionId: string): AssistantTool => ({
		...tool(actionId),
		kind,
	});

	it('are kept with a write tool of the same area, even when they would be cut', () => {
		const crowded = [
			as('draft', 'lists.addShoppingItems'),
			// Far more tools of another area than fit, ahead of the read tool that matters.
			...Array.from({ length: 30 }, (_, i) => as('read', `vehicles.read${i}`)),
			as('read', 'lists.shoppingList'),
		];
		const picked = narrow(crowded, 'Add picture wire to the Hardware store', words).map(
			(t) => t.actionId,
		);
		expect(picked).toContain('lists.addShoppingItems');
		expect(picked).toContain('lists.shoppingList');
		expect(picked).toHaveLength(24);
	});

	it('are not added for an area whose write tools were all cut', () => {
		const crowded = [
			...Array.from({ length: 30 }, (_, i) => as('draft', `vehicles.add${i}`)),
			as('read', 'lists.shoppingList'),
		];
		const picked = narrow(crowded, 'anything', words).map((t) => t.actionId);
		expect(picked).not.toContain('lists.shoppingList');
	});
});
