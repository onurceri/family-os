import { describe, expect, it } from 'vitest';
import { awaitedChanges, awaitedNew, type WaitingDraft, waitingChanges } from './awaiting.js';

const awaitedIds = (drafts: readonly WaitingDraft[], memberId: string | undefined) =>
	new Set(awaitedChanges(drafts, memberId).keys());

const draft = (over: Partial<WaitingDraft>): WaitingDraft => ({
	actionId: 'lists.updateTask',
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

	it('keeps the change that waits, the newest of several, with what it changes now', () => {
		const changes = awaitedChanges(
			[
				draft({
					actionId: 'lists.updateTask',
					input: { id: 'task_1', task: { title: 'Worksheet', dueDate: '2026-10-20' } },
					before: { dueDate: null },
				}),
				draft({ actionId: 'lists.deleteTask', input: { id: 'task_1' } }),
			],
			'ivy',
		);
		expect(changes.get('task_1')).toEqual({
			actionId: 'lists.updateTask',
			input: { id: 'task_1', task: { title: 'Worksheet', dueDate: '2026-10-20' } },
			before: { dueDate: null },
		});
	});

	it('shows the one who may decide another person’s change, with who asked', () => {
		const changes = awaitedChanges(
			[
				draft({
					proposedBy: { kind: 'member', memberId: 'leo' },
					canDecide: true,
					input: { id: 'e1' },
				}),
				draft({
					proposedBy: { kind: 'ai', mode: 'share', source: 'inbox', onBehalfOf: 'ivy' },
					canDecide: true,
					input: { id: 'e2' },
				}),
				// What an assistant proposed for nobody in particular is no person's change.
				draft({ proposedBy: { kind: 'ai', mode: 'mcp' }, canDecide: true, input: { id: 'e3' } }),
			],
			'mara',
		);
		expect(changes.get('e1')?.by).toBe('leo');
		expect(changes.get('e2')?.by).toBe('ivy');
		expect(changes.has('e3')).toBe(false);
		// The person who asked sees it without a name.
		expect(awaitedChanges([draft({ input: { id: 'e1' } })], 'ivy').get('e1')?.by).toBeUndefined();
	});
});

describe('new entries that wait for approval', () => {
	const changes = waitingChanges(
		[
			draft({
				id: 'd3',
				actionId: 'pets.addTreatment',
				input: { petId: 'pet_1', product: 'Worming' },
			}),
			draft({
				id: 'd2',
				actionId: 'pets.addTreatment',
				input: { petId: 'pet_2', product: 'Rabies' },
			}),
			draft({
				id: 'd1',
				actionId: 'pets.addTreatment',
				input: { petId: 'pet_1', product: 'Rabies' },
			}),
			draft({ id: 'd0', actionId: 'pets.updatePet', input: { id: 'pet_1', name: 'Biscuit' } }),
		],
		'ivy',
	);

	it('are those of the given actions about the given record, oldest first', () => {
		expect(awaitedNew(changes, ['pets.addTreatment'], 'pet_1').map((c) => c.draftId)).toEqual([
			'd1',
			'd3',
		]);
		expect(awaitedNew(changes, ['pets.addTreatment']).map((c) => c.draftId)).toEqual([
			'd1',
			'd2',
			'd3',
		]);
		expect(awaitedNew(changes, ['pets.addTreatment'], 'pet_9')).toEqual([]);
	});
});
