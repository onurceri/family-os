import { describe, expect, it } from 'vitest';
import { awaitedIds, type WaitingDraft } from './awaiting.js';

const draft = (over: Partial<WaitingDraft>): WaitingDraft => ({
	status: 'pending',
	input: {},
	editedInput: null,
	proposedBy: { kind: 'member', memberId: 'ivy' },
	canDecide: false,
	...over,
});

describe('what the member’s own changes wait on', () => {
	it('marks the record each of their waiting changes is about', () => {
		const ids = awaitedIds(
			[
				draft({ input: { id: 'task_1', task: { title: 'Worksheet' }, label: 'Worksheet' } }),
				draft({ input: { petId: 'pet_1', kind: 'vaccination', product: 'Rabies' } }),
				draft({ status: 'failed', input: { id: 'shop_item_1' } }),
				// People of an event are not what it is about.
				draft({ input: { id: 'cal_event_1', memberIds: ['member_1'] } }),
			],
			'ivy',
		);
		expect([...ids].sort()).toEqual(['cal_event_1', 'pet_1', 'shop_item_1', 'task_1']);
	});

	it('reads a saved edit before what was first proposed', () => {
		const ids = awaitedIds(
			[draft({ input: { id: 'task_1' }, editedInput: { id: 'task_2' } })],
			'ivy',
		);
		expect([...ids]).toEqual(['task_2']);
	});

	it('leaves out what is decided, what others asked for and what the member decides', () => {
		const ids = awaitedIds(
			[
				draft({ status: 'applied', input: { id: 'a' } }),
				draft({ status: 'rejected', input: { id: 'b' } }),
				draft({ proposedBy: { kind: 'member', memberId: 'leo' }, input: { id: 'c' } }),
				draft({ canDecide: true, input: { id: 'd' } }),
			],
			'ivy',
		);
		expect(ids.size).toBe(0);
		expect(awaitedIds([draft({ input: { id: 'x' } })], undefined).size).toBe(0);
	});

	it('counts what an assistant or a shared message asked for the member', () => {
		const ids = awaitedIds(
			[
				draft({
					proposedBy: { kind: 'ai', mode: 'conversation', source: 'assistant', onBehalfOf: 'ivy' },
					input: { id: 'task_9' },
				}),
			],
			'ivy',
		);
		expect([...ids]).toEqual(['task_9']);
	});
});
