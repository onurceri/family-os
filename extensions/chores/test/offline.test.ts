import { isFamosError } from '@famos/sdk';
import type { TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Chore, MarkDoneResult } from '../src/contract/index.ts';
import { applied, createKernel, type Person, person } from './support.ts';

// Offline replays: a queued "done" or "undo" is sent again with its key, possibly
// after the chore changed meanwhile.

let k: TestKernel;
let ayse: Person;
let bora: Person;

beforeEach(async () => {
	({ k } = await createKernel());
	ayse = await person(k, 'admin', 'Ayşe');
	bora = await person(k, 'member', 'Bora');
});
afterEach(() => k.close());

const TODAY = '2026-10-06';
const create = () =>
	applied<Chore>(
		k,
		'chores.createChore',
		{ title: 'Dishes', startDate: TODAY, assigneeIds: [ayse.id, bora.id] },
		ayse.actor,
	);
const list = (): Promise<Chore[]> => k.route('chores.listAllChores').call();
const completions = async () =>
	Number(
		(
			await k.ctx.db
				.withTables<{ chores_completions: { id: string } }>()
				.selectFrom('chores_completions')
				.select((eb) => eb.fn.countAll().as('n'))
				.executeTakeFirstOrThrow()
		).n,
	);
const codeOf = (promise: Promise<unknown>) =>
	promise.then(
		() => 'ok',
		(e: unknown) => (isFamosError(e) ? e.code : 'other'),
	);

it('declares done and undo as offline-capable', () => {
	expect(k.registry.actions.get('chores.markDone')?.offline).toBe(true);
	expect(k.registry.actions.get('chores.undoDone')?.offline).toBe(true);
});

describe('chore replays', () => {
	it('marks done once for a repeated key', async () => {
		const chore = await create();
		const input = { id: chore.id, dueDate: chore.nextDue };
		const options = { idempotencyKey: 'chore_1' };
		const first = await k.runner.invoke('chores.markDone', input, ayse.actor, options);
		const second = await k.runner.invoke('chores.markDone', input, ayse.actor, options);
		expect(second).toEqual(first);
		expect(await completions()).toBe(1);
	});

	it('a late tap for a date someone else already did records nothing', async () => {
		const chore = await create();
		const input = { id: chore.id, dueDate: chore.nextDue };
		await applied<MarkDoneResult>(k, 'chores.markDone', input, bora.actor);
		const late = await applied<MarkDoneResult>(k, 'chores.markDone', input, ayse.actor);
		expect(late.completion).toBeNull();
		expect(await completions()).toBe(1);
	});

	it('undoes once for a repeated key, and again after the undo gives the same answer', async () => {
		const chore = await create();
		const done = await applied<MarkDoneResult>(
			k,
			'chores.markDone',
			{ id: chore.id, dueDate: chore.nextDue },
			ayse.actor,
		);
		const input = { completionId: done.completion?.id };
		const options = { idempotencyKey: 'undo_1' };
		await k.runner.invoke('chores.undoDone', input, ayse.actor, options);
		await k.runner.invoke('chores.undoDone', input, ayse.actor, options);
		expect((await list())[0]?.nextDue).toBe(TODAY);
		// Another request for the same completion: already undone, no error, nothing changes.
		await k.runner.invoke('chores.undoDone', input, ayse.actor, { idempotencyKey: 'undo_2' });
		expect((await list())[0]?.nextDue).toBe(TODAY);
	});

	it('answers a late undo of a completion that does not exist with a stored not_found', async () => {
		const options = { idempotencyKey: 'undo_x' };
		const run = () =>
			codeOf(
				k.runner.invoke(
					'chores.undoDone',
					{ completionId: k.ctx.ids.next('chore_done') },
					ayse.actor,
					options,
				),
			);
		expect(await run()).toBe('not_found');
		expect(await run()).toBe('not_found');
	});

	it('a late tap on an archived chore is a not_found, not a crash', async () => {
		const chore = await create();
		await applied(k, 'chores.archiveChore', { id: chore.id }, ayse.actor);
		expect(
			await codeOf(
				k.runner.invoke('chores.markDone', { id: chore.id, dueDate: chore.nextDue }, ayse.actor, {
					idempotencyKey: 'late',
				}),
			),
		).toBe('not_found');
	});
});
