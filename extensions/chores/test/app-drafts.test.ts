import type { Actor } from '@famos/sdk';
import type { TestKernel } from '@famos/testing';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Chore, MarkDoneResult } from '../src/contract/index.ts';
import { applied, createKernel, type Person, person } from './support.ts';

let k: TestKernel;
let ayse: Person;

beforeEach(async () => {
	({ k } = await createKernel());
	ayse = await person(k, 'admin', 'Ayşe');
	await sql`insert into core_apps (id, name, role_id, mode, acts_for, created_at, updated_at)
		values ('app_home', 'Home Assistant', 'member', 'suggest', '[]', 0, 0)`.execute(k.ctx.db);
});
afterEach(() => k.close());

const suggesting: Actor = {
	kind: 'app',
	appId: 'app_home',
	roleId: 'member',
	mode: 'suggest',
};

const waiting = async () =>
	(await k.route('core.listDrafts').call({ actor: ayse.actor, query: { limit: 50 } })) as {
		actionId: string;
		subject: string | null;
		input: { label?: string };
		app: { id: string; name: string } | null;
	}[];

describe('suggestions a connected app makes', () => {
	it('name the chore they complete, though the program sends no label', async () => {
		const chore = await applied<Chore>(
			k,
			'chores.createChore',
			{ title: 'Empty the dishwasher', startDate: '2026-10-06' },
			ayse.actor,
		);
		const result = await k.runner.invoke(
			'chores.markDone',
			{ id: chore.id, dueDate: chore.nextDue },
			suggesting,
		);
		expect(result.status).toBe('drafted');
		const [draft] = await waiting();
		expect(draft).toMatchObject({
			actionId: 'chores.markDone',
			subject: 'Empty the dishwasher',
			input: { label: 'Empty the dishwasher' },
			app: { id: 'app_home', name: 'Home Assistant' },
		});
	});

	it('name the chore whose completion they take back', async () => {
		const chore = await applied<Chore>(
			k,
			'chores.createChore',
			{ title: 'Water the plants', startDate: '2026-10-06' },
			ayse.actor,
		);
		const done = await applied<MarkDoneResult>(
			k,
			'chores.markDone',
			{ id: chore.id, dueDate: chore.nextDue },
			ayse.actor,
		);
		const completionId = done.completion?.id;
		await k.runner.invoke('chores.undoDone', { completionId }, suggesting);
		const [draft] = await waiting();
		expect(draft).toMatchObject({ actionId: 'chores.undoDone', subject: 'Water the plants' });
	});
});
