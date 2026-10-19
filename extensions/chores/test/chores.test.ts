import type { TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Chore, ChoreDetail, MarkDoneResult } from '../src/contract/index.ts';
import { AI, applied, at, createKernel, mayCall, type Person, person } from './support.ts';

let k: TestKernel;
let channel: Awaited<ReturnType<typeof createKernel>>['channel'];
let ayse: Person; // admin
let bora: Person; // member: edit
let elif: Person; // supervised: use
let guest: Person; // guest: view

beforeEach(async () => {
	({ k, channel } = await createKernel());
	ayse = await person(k, 'admin', 'Ayşe');
	bora = await person(k, 'member', 'Bora');
	elif = await person(k, 'supervised', 'Elif');
	guest = await person(k, 'guest', 'Misafir');
});
afterEach(() => k.close());

const TODAY = '2026-10-06'; // a Tuesday
const create = (input: Record<string, unknown> = {}, actor = ayse.actor) =>
	applied<Chore>(
		k,
		'chores.createChore',
		{ title: 'Dishes', startDate: TODAY, assigneeIds: [ayse.id, bora.id], ...input },
		actor,
	);
const done = (c: Chore, actor = ayse.actor, extra: Record<string, unknown> = {}) =>
	applied<MarkDoneResult>(k, 'chores.markDone', { id: c.id, dueDate: c.nextDue, ...extra }, actor);
const list = (): Promise<Chore[]> => k.route('chores.listAllChores').call();
const get = async (id: string): Promise<Chore> => (await list()).find((c) => c.id === id) as Chore;
const rejected = (p: Promise<unknown>) =>
	p.then(
		() => null,
		(e: { code?: string }) => e.code ?? 'error',
	);

describe('chores', () => {
	it('says why a tap changed nothing', async () => {
		const c = await create();
		const first = await done(c);
		expect(first.completion).not.toBeNull();
		expect(first.reason).toBeUndefined();
		const same = await applied<MarkDoneResult>(
			k,
			'chores.markDone',
			{ id: c.id, dueDate: c.nextDue },
			ayse.actor,
		);
		expect(same).toMatchObject({ completion: null, reason: 'already_done' });
		const moved = await applied<MarkDoneResult>(
			k,
			'chores.markDone',
			{ id: c.id, dueDate: '2030-01-01' },
			ayse.actor,
		);
		expect(moved).toMatchObject({ completion: null, reason: 'stale' });
	});

	it('credits the person whose turn it was when someone else taps without naming anyone, and the tapper for a chore anyone may do', async () => {
		const chore = await create();
		// Bora ticks Ayşe's turn off without saying who did it.
		const tapped = await done(chore, bora.actor);
		expect(tapped.completion?.memberId).toBe(ayse.id);
		const open = await create({ title: 'Plants', assigneeIds: [] });
		expect((await done(open, bora.actor)).completion?.memberId).toBe(bora.id);
		// Someone who cannot edit still may not tick off another person's turn.
		const another = await create({ title: 'Trash', assigneeIds: [ayse.id] });
		expect(await rejected(done(another, elif.actor))).toBe('forbidden');
	});

	it('adds a chore with its people in turn order and the first one up', async () => {
		const chore = await create({
			notes: 'Before bed',
			recurrence: { freq: 'daily', interval: 1 },
			rotation: 'round_robin',
		});
		expect(chore).toMatchObject({
			title: 'Dishes',
			notes: 'Before bed',
			nextDue: TODAY,
			overdue: false,
			rotation: 'round_robin',
			assigneeId: ayse.id,
			assigneeIds: [ayse.id, bora.id],
			lastDone: null,
		});
		expect(chore.id).toMatch(/^chore_/);
		expect(await list()).toHaveLength(1);
	});

	it('refuses an unknown member, a repeat that ends before it starts and an empty title', async () => {
		const unknown = 'member_00000000-0000-7000-8000-000000000999';
		expect(await rejected(create({ assigneeIds: [unknown] }))).toBe('bad_request');
		expect(
			await rejected(
				create({
					startDate: '2026-10-20',
					recurrence: { freq: 'weekly', interval: 1, byDay: ['MO'], until: '2026-10-10' },
				}),
			),
		).toBe('bad_request');
		expect(await rejected(create({ title: '  ' }))).toBe('bad_request');
		expect(await rejected(create({ assigneeIds: [ayse.id, ayse.id] }))).toBe('bad_request');
		expect(await list()).toHaveLength(0);
	});

	it('shows the chore as overdue once its day has passed', async () => {
		const chore = await create({ startDate: '2026-10-04' });
		expect(chore).toMatchObject({ nextDue: '2026-10-04', overdue: true });
	});

	it('changes a chore, moving the schedule only when the start or repeat changes', async () => {
		const chore = await create({ recurrence: { freq: 'weekly', interval: 1, byDay: ['MO'] } });
		expect(chore.nextDue).toBe('2026-10-12');
		const renamed = await applied<Chore>(
			k,
			'chores.updateChore',
			{
				id: chore.id,
				chore: {
					title: 'Wash up',
					notes: null,
					startDate: TODAY,
					recurrence: { freq: 'weekly', interval: 1, byDay: ['MO'] },
					rotation: 'round_robin',
				},
			},
			ayse.actor,
		);
		expect(renamed).toMatchObject({ title: 'Wash up', nextDue: '2026-10-12' });
		const moved = await applied<Chore>(
			k,
			'chores.updateChore',
			{
				id: chore.id,
				chore: {
					title: 'Wash up',
					notes: null,
					startDate: TODAY,
					recurrence: { freq: 'weekly', interval: 1, byDay: ['FR'] },
					rotation: 'round_robin',
				},
			},
			ayse.actor,
		);
		expect(moved.nextDue).toBe('2026-10-09');
		// People are kept when the chore itself is edited.
		expect(moved.assigneeIds).toEqual([ayse.id, bora.id]);
		// The form sends the whole chore: one that leaves fields out is refused, not cleared.
		expect(
			await rejected(
				k.runner.invoke(
					'chores.updateChore',
					{ id: chore.id, chore: { title: 'Dishes', startDate: TODAY } },
					ayse.actor,
				),
			),
		).toBe('bad_request');
		expect(await get(chore.id)).toMatchObject({ title: 'Wash up', rotation: 'round_robin' });
	});

	it('archives a chore, hiding it and its reminders, and again without harm', async () => {
		const chore = await create();
		await applied(k, 'chores.archiveChore', { id: chore.id }, ayse.actor);
		await applied(k, 'chores.archiveChore', { id: chore.id }, ayse.actor);
		expect(await list()).toHaveLength(0);
		expect(await rejected(done(chore))).toBe('not_found');
	});

	it('flags a chore that seems to exist already when it is proposed again', async () => {
		await create();
		const proposed = await k.runner.invoke(
			'chores.createChore',
			{ title: 'Dishes', startDate: TODAY },
			elif.actor,
		);
		expect(proposed.status).toBe('drafted');
		if (proposed.status !== 'drafted') return;
		const drafts = (await k.route('core.listDrafts').call({ query: { limit: 10 } })) as {
			id: string;
			mayExist: boolean;
		}[];
		expect(drafts.find((d) => d.id === proposed.draftId)?.mayExist).toBe(true);
	});
});

describe('marking done and the next due date', () => {
	it('weekly: moves a week on and hands over to the next person', async () => {
		const chore = await create({
			startDate: '2026-10-05',
			recurrence: { freq: 'weekly', interval: 1, byDay: ['MO'] },
			rotation: 'round_robin',
		});
		expect(chore).toMatchObject({ nextDue: '2026-10-05', overdue: true, assigneeId: ayse.id });
		const result = await done(chore);
		expect(result.completion).toMatchObject({ memberId: ayse.id, dueDate: '2026-10-05' });
		expect(result.chore).toMatchObject({
			nextDue: '2026-10-12',
			overdue: false,
			assigneeId: bora.id,
			lastDone: { memberId: ayse.id },
		});
	});

	it('monthly: an end-of-month chore lands on the last day of short months', async () => {
		const chore = await create({
			startDate: '2026-10-31',
			recurrence: { freq: 'monthly', interval: 1 },
		});
		expect(chore.nextDue).toBe('2026-10-31');
		const first = await done(chore);
		expect(first.chore.nextDue).toBe('2026-11-30');
		k.clock.set(at('2026-11-30', '12:00'));
		const second = await done(first.chore);
		expect(second.chore.nextDue).toBe('2026-12-31');
	});

	it('one-off: done once, it has no next date and stays listed for a week', async () => {
		const chore = await create({ startDate: '2026-10-08', rotation: 'round_robin' });
		const result = await done(chore, bora.actor);
		expect(result.chore).toMatchObject({ nextDue: null, overdue: false });
		expect((await list()).map((c) => c.id)).toEqual([chore.id]);
		k.clock.set(at('2026-10-14', '10:00'));
		expect(await list()).toHaveLength(0);
	});

	it('skips occurrences that were missed instead of piling them up', async () => {
		const chore = await create({
			startDate: '2026-09-01',
			recurrence: { freq: 'weekly', interval: 1, byDay: ['TU'] },
		});
		expect(chore.nextDue).toBe('2026-09-01');
		const result = await done(chore);
		expect(result.chore.nextDue).toBe('2026-10-13');
	});

	it('is idempotent: tapping again for the same day changes nothing', async () => {
		const chore = await create({ recurrence: { freq: 'daily', interval: 1 } });
		await done(chore);
		const again = await done(chore); // the same stale due date
		expect(again.completion).toBeNull();
		expect(again.chore.nextDue).toBe('2026-10-07');
		const detail: ChoreDetail = await k
			.route('chores.getChore')
			.call({ params: { choreId: chore.id } });
		expect(detail.history).toHaveLength(1);
	});

	it('records who did it when an editor marks it done for someone else', async () => {
		const chore = await create({ rotation: 'round_robin' });
		const result = await done(chore, bora.actor, { doneBy: ayse.id });
		expect(result.completion?.memberId).toBe(ayse.id);
		expect(result.chore.lastDone?.memberId).toBe(ayse.id);
	});
});

describe('rotation in use', () => {
	const turns = async (c: Chore, who: (up: string | null) => Person, times: number) => {
		const ups: (string | null)[] = [];
		let chore = c;
		for (let i = 0; i < times; i++) {
			ups.push(chore.assigneeId);
			chore = (await done(chore, who(chore.assigneeId).actor)).chore;
		}
		ups.push(chore.assigneeId);
		return ups;
	};
	const byId = (up: string | null) => [ayse, bora, elif].find((p) => p.id === up) as Person;

	it('fixed: the same person every time', async () => {
		const chore = await create({ recurrence: { freq: 'daily', interval: 1 }, rotation: 'fixed' });
		expect(await turns(chore, byId, 3)).toEqual([ayse.id, ayse.id, ayse.id, ayse.id]);
	});

	it('round robin: takes turns in the listed order and wraps around', async () => {
		const chore = await create({
			assigneeIds: [ayse.id, bora.id, elif.id],
			recurrence: { freq: 'daily', interval: 1 },
			rotation: 'round_robin',
		});
		expect(await turns(chore, byId, 4)).toEqual([ayse.id, bora.id, elif.id, ayse.id, bora.id]);
	});

	it('least done: evens the load out, ties by position', async () => {
		const chore = await create({
			assigneeIds: [ayse.id, bora.id],
			recurrence: { freq: 'daily', interval: 1 },
			rotation: 'least_done',
		});
		// Ayşe does it, then Bora; Ayşe does it again, so Bora is next.
		const first = await done(chore, ayse.actor);
		expect(first.chore.assigneeId).toBe(bora.id);
		const second = await done(first.chore, bora.actor);
		expect(second.chore.assigneeId).toBe(ayse.id); // 1 each: position decides
		const third = await done(second.chore, ayse.actor);
		expect(third.chore.assigneeId).toBe(bora.id); // Ayşe 2, Bora 1
		// Bora skips and Ayşe covers twice more: Bora stays the one with the fewest.
		const fourth = await done(third.chore, ayse.actor, { doneBy: ayse.id });
		expect(fourth.chore.assigneeId).toBe(bora.id);
	});

	it('anyone: a chore with nobody listed stays open to everyone', async () => {
		const chore = await create({ assigneeIds: [], recurrence: { freq: 'daily', interval: 1 } });
		expect(chore.assigneeId).toBeNull();
		const result = await done(chore, elif.actor);
		expect(result.chore.assigneeId).toBeNull();
	});

	it('changing the people keeps whose turn it is when that person stays, else starts the list', async () => {
		const chore = await create({ assigneeIds: [ayse.id, bora.id], rotation: 'round_robin' });
		const kept = await applied<{ chore: Chore; previousAssigneeIds: string[] }>(
			k,
			'chores.setAssignees',
			{ id: chore.id, memberIds: [bora.id, ayse.id] },
			ayse.actor,
		);
		expect(kept.previousAssigneeIds).toEqual([ayse.id, bora.id]);
		expect(kept.chore).toMatchObject({ assigneeIds: [bora.id, ayse.id], assigneeId: ayse.id });
		const replaced = await applied<{ chore: Chore }>(
			k,
			'chores.setAssignees',
			{ id: chore.id, memberIds: [elif.id, bora.id] },
			ayse.actor,
		);
		expect(replaced.chore.assigneeId).toBe(elif.id);
		const anyone = await applied<{ chore: Chore }>(
			k,
			'chores.setAssignees',
			{ id: chore.id, memberIds: [] },
			ayse.actor,
		);
		expect(anyone.chore).toMatchObject({ assigneeId: null, assigneeIds: [] });
	});
});

describe('undo', () => {
	it('puts the due date and whose turn it was back', async () => {
		const chore = await create({
			recurrence: { freq: 'daily', interval: 1 },
			rotation: 'round_robin',
		});
		const result = await done(chore);
		expect(result.chore).toMatchObject({ nextDue: '2026-10-07', assigneeId: bora.id });
		const undone = await applied<Chore>(
			k,
			'chores.undoDone',
			{ completionId: result.completion?.id },
			ayse.actor,
		);
		expect(undone).toMatchObject({ nextDue: TODAY, assigneeId: ayse.id, lastDone: null });
		// Idempotent, and the day can be done again.
		await applied(k, 'chores.undoDone', { completionId: result.completion?.id }, ayse.actor);
		expect((await done(undone)).completion).not.toBeNull();
	});

	it('undoes only the latest completion of a chore', async () => {
		const chore = await create({ recurrence: { freq: 'daily', interval: 1 } });
		const first = await done(chore);
		const second = await done(first.chore);
		expect(
			await rejected(
				k.runner.invoke('chores.undoDone', { completionId: first.completion?.id }, ayse.actor),
			),
		).toBe('conflict');
		await applied(k, 'chores.undoDone', { completionId: second.completion?.id }, ayse.actor);
		await applied(k, 'chores.undoDone', { completionId: first.completion?.id }, ayse.actor);
	});

	it('lets a person undo their own completion the same day only; an editor any', async () => {
		const chore = await create({
			assigneeIds: [elif.id],
			recurrence: { freq: 'daily', interval: 1 },
		});
		const first = await done(chore, elif.actor);
		expect(
			await rejected(
				k.runner.invoke('chores.undoDone', { completionId: first.completion?.id }, guest.actor),
			),
		).toBe('forbidden');
		const other = await create({
			title: 'Bins',
			assigneeIds: [],
			recurrence: { freq: 'daily', interval: 1 },
		});
		const theirs = await done(other, ayse.actor);
		expect(
			await rejected(
				k.runner.invoke('chores.undoDone', { completionId: theirs.completion?.id }, elif.actor),
			),
		).toBe('forbidden');
		k.clock.set(at('2026-10-07', '10:00'));
		expect(
			await rejected(
				k.runner.invoke('chores.undoDone', { completionId: first.completion?.id }, elif.actor),
			),
		).toBe('forbidden');
		await applied(k, 'chores.undoDone', { completionId: first.completion?.id }, bora.actor);
	});
});

describe('who may do what', () => {
	it('guests only look; supervised members tick off their own turn and anyone-chores', async () => {
		const own = await create({ title: 'Own', assigneeIds: [elif.id] });
		const other = await create({ title: 'Other', assigneeIds: [bora.id] });
		const open = await create({ title: 'Open', assigneeIds: [] });
		expect(
			await rejected(
				k.runner.invoke('chores.markDone', { id: own.id, dueDate: TODAY }, guest.actor),
			),
		).toBe('forbidden');
		expect((await done(own, elif.actor)).completion).not.toBeNull();
		expect(await rejected(done(other, elif.actor))).toBe('forbidden');
		expect((await done(open, elif.actor)).completion).not.toBeNull();
		// Not even for a friend without edit.
		const another = await create({ title: 'Another', assigneeIds: [] });
		expect(await rejected(done(another, elif.actor, { doneBy: bora.id }))).toBe('forbidden');
		// An editor may.
		expect((await done(other, bora.actor)).completion?.memberId).toBe(bora.id);
		expect((await done(another, bora.actor, { doneBy: elif.id })).completion?.memberId).toBe(
			elif.id,
		);
	});

	it('drafts chores proposed by someone who cannot edit, and applies them when approved', async () => {
		const proposed = await k.runner.invoke(
			'chores.createChore',
			{ title: 'Plants', startDate: TODAY, assigneeIds: [elif.id] },
			elif.actor,
		);
		expect(proposed.status).toBe('drafted');
		expect(await list()).toHaveLength(0);
		if (proposed.status !== 'drafted') return;
		await k.runner.approveDraft(proposed.draftId, ayse.actor);
		expect((await list()).map((c) => c.title)).toEqual(['Plants']);
		// An editor does it directly; archiving is also a draft for a supervised member.
		const direct = await k.runner.invoke(
			'chores.createChore',
			{ title: 'Bins', startDate: TODAY },
			bora.actor,
		);
		expect(direct.status).toBe('applied');
		const [plants] = await list();
		expect(
			(await k.runner.invoke('chores.archiveChore', { id: plants?.id }, elif.actor)).status,
		).toBe('drafted');
	});

	it('refuses a suggestion about a chore that does not exist, as a direct run is', async () => {
		const ghost = 'chore_00000000-0000-7000-8000-000000000000';
		for (const [action, input] of [
			['chores.archiveChore', { id: ghost }],
			['chores.setAssignees', { id: ghost, memberIds: [bora.id] }],
		] as const) {
			expect(await rejected(k.runner.invoke(action, input, elif.actor))).toBe('not_found');
			expect(await rejected(k.runner.invoke(action, input, ayse.actor))).toBe('not_found');
		}
		// An archived chore is no longer there either.
		const gone = await create({ title: 'Old' });
		await applied(k, 'chores.archiveChore', { id: gone.id }, ayse.actor);
		expect(
			await rejected(
				k.runner.invoke('chores.setAssignees', { id: gone.id, memberIds: [bora.id] }, elif.actor),
			),
		).toBe('not_found');
	});

	it('shows chores to guests and displays only what the view capability allows', async () => {
		expect(mayCall(k, guest.actor, 'chores.listAllChores')).toBe(true);
		expect(mayCall(k, guest.actor, 'chores.getChore')).toBe(true);
	});
});

describe('the AI', () => {
	it('can propose chores, a fair split and a completion as drafts, but not edits', async () => {
		const ids = k.ctx.actions.aiCatalog().map((a) => a.id);
		expect(ids).toContain('chores.createChore');
		expect(ids).toContain('chores.setAssignees');
		// A completion the AI proposes waits for a person, like everything it proposes.
		expect(ids).toContain('chores.markDone');
		for (const id of ['chores.undoDone', 'chores.updateChore', 'chores.archiveChore'])
			expect(ids).not.toContain(id);
		const reads = k.ctx.actions.aiReadTools().map((a) => a.id);
		expect(reads).toContain('chores.listChores');
	});

	it('answers whose turn it is', async () => {
		await create({
			recurrence: { freq: 'daily', interval: 1 },
			rotation: 'round_robin',
		});
		const out = await applied<{
			chores: { title: string; assigneeId: string | null }[];
			today: string;
		}>(k, 'chores.listChores', {}, AI);
		expect(out.today).toBe(TODAY);
		expect(out.chores).toEqual([expect.objectContaining({ title: 'Dishes', assigneeId: ayse.id })]);
		const forBora = await applied<{ chores: unknown[] }>(
			k,
			'chores.listChores',
			{ assignee: bora.id },
			AI,
		);
		expect(forBora.chores).toEqual([]);
	});

	it('names the chore and who takes turns now on a split someone sent for approval', async () => {
		const chore = await create({ title: 'Take out the bins', assigneeIds: [bora.id, ayse.id] });
		// The page sends only the id and the new people.
		const proposal = await k.runner.invoke(
			'chores.setAssignees',
			{ id: chore.id, memberIds: [elif.id, ayse.id] },
			elif.actor,
		);
		if (proposal.status !== 'drafted') throw new Error('expected a draft');
		expect(proposal).toMatchObject({ subject: 'Take out the bins' });
		const drafts = (await k.route('core.listDrafts').call({
			actor: ayse.actor,
			query: { limit: 20 },
		})) as { id: string; input: { label?: string }; before: unknown }[];
		const draft = drafts.find((d) => d.id === proposal.draftId);
		expect(draft?.input.label).toBe('Take out the bins');
		expect(draft?.before).toEqual({ memberIds: [bora.id, ayse.id] });
	});

	it('proposes a split as a draft, and an approved split can be taken back', async () => {
		const chore = await create({ assigneeIds: [ayse.id] });
		const proposal = await k.runner.invoke(
			'chores.setAssignees',
			{ id: chore.id, memberIds: [bora.id, elif.id] },
			AI,
		);
		expect(proposal.status).toBe('drafted');
		expect((await get(chore.id)).assigneeIds).toEqual([ayse.id]);
		if (proposal.status !== 'drafted') return;
		await k.runner.approveDraft(proposal.draftId, ayse.actor);
		expect(await get(chore.id)).toMatchObject({
			assigneeIds: [bora.id, elif.id],
			assigneeId: bora.id,
		});
		await k.runner.undoDraft(proposal.draftId, ayse.actor);
		expect(await get(chore.id)).toMatchObject({ assigneeIds: [ayse.id] });
		// A proposed chore is undone by archiving it.
		const created = await k.runner.invoke(
			'chores.createChore',
			{ title: 'Plants', startDate: TODAY, assigneeIds: [elif.id] },
			AI,
		);
		if (created.status !== 'drafted') throw new Error('expected a draft');
		await k.runner.approveDraft(created.draftId, ayse.actor);
		expect(await list()).toHaveLength(2);
		await k.runner.undoDraft(created.draftId, ayse.actor);
		expect((await list()).map((c) => c.title)).toEqual(['Dishes']);
	});
});

describe('reminders', () => {
	const sent = () => channel.sent.filter((s) => s.message.title.includes('chore_due_title'));
	const advanceTo = async (ms: number) => {
		k.clock.set(ms);
		await k.worker.drain();
	};
	const pending = async () =>
		(
			await k.ctx.db
				.withTables<{ queue_jobs: { name: string; status: string; dedupe_key: string | null } }>()
				.selectFrom('queue_jobs')
				.select(['dedupe_key'])
				.where('name', '=', 'chores.remind')
				.where('status', '=', 'pending')
				.execute()
		).map((r) => r.dedupe_key);

	it('tells whoever is up on the due day at 09:00, once', async () => {
		await create({ startDate: '2026-10-08', assigneeIds: [bora.id] });
		await advanceTo(at('2026-10-08', '09:00') - 1);
		expect(sent()).toHaveLength(0);
		await advanceTo(at('2026-10-08', '09:00'));
		expect(sent().map((s) => s.memberId)).toEqual([bora.id]);
		expect(sent()[0]?.message).toMatchObject({
			title: 'en|chores:chore_due_title|{"title":"Dishes"}',
			body: 'en|chores:chore_due_today|{}',
			url: '/chores',
		});
		await advanceTo(at('2026-10-08', '15:00'));
		expect(sent()).toHaveLength(1);
	});

	it('tells nobody about a chore anyone may do', async () => {
		await create({ startDate: '2026-10-08', assigneeIds: [] });
		expect(await pending()).toEqual([]);
		await advanceTo(at('2026-10-08', '12:00'));
		expect(sent()).toHaveLength(0);
	});

	it('plans one job per change, deduplicated by its version', async () => {
		const chore = await create({ startDate: '2026-10-08' });
		const jobs = await pending();
		expect(jobs).toEqual([
			expect.stringMatching(new RegExp(`^chores.remind:${chore.id}:2026-10-08:`)),
		]);
		// Changing nothing in the same instant plans the same job, so it is not doubled.
		await applied(
			k,
			'chores.setAssignees',
			{ id: chore.id, memberIds: [ayse.id, bora.id] },
			ayse.actor,
		);
		expect(await pending()).toEqual(jobs);
	});

	it('forgets a reminder when the chore is done, handed over, moved or archived', async () => {
		const done1 = await create({ title: 'Done', startDate: '2026-10-08' });
		const handed = await create({
			title: 'Handed',
			startDate: '2026-10-08',
			assigneeIds: [ayse.id],
		});
		const archived = await create({ title: 'Gone', startDate: '2026-10-08' });
		await done(done1);
		await applied(k, 'chores.setAssignees', { id: handed.id, memberIds: [] }, ayse.actor);
		await applied(k, 'chores.archiveChore', { id: archived.id }, ayse.actor);
		await advanceTo(at('2026-10-08', '12:00'));
		expect(sent()).toHaveLength(0);
	});

	it('plans the next reminder after a repeating chore is done', async () => {
		const chore = await create({
			startDate: '2026-10-06',
			recurrence: { freq: 'daily', interval: 1 },
			rotation: 'round_robin',
		});
		await done(chore);
		await advanceTo(at('2026-10-07', '09:00'));
		expect(sent().map((s) => s.memberId)).toEqual([bora.id]);
	});

	it('does not remind about a day that has passed', async () => {
		await create({ startDate: '2026-10-08' });
		await advanceTo(at('2026-10-10', '09:00'));
		expect(sent()).toHaveLength(0);
	});
});

describe('history', () => {
	it('lists who did a chore lately', async () => {
		const chore = await create({ recurrence: { freq: 'daily', interval: 1 } });
		const first = await done(chore, ayse.actor);
		await done(first.chore, ayse.actor);
		const detail: ChoreDetail = await k
			.route('chores.getChore')
			.call({ params: { choreId: chore.id } });
		expect(detail.history.map((h) => h.dueDate)).toEqual(['2026-10-07', '2026-10-06']);
		expect(detail.history[0]).toMatchObject({ memberId: ayse.id, undoneAt: null });
		await expect(
			k
				.route('chores.getChore')
				.call({ params: { choreId: 'chore_00000000-0000-7000-8000-000000000001' } }),
		).rejects.toMatchObject({ code: 'not_found' });
	});

	it('closes a suggested "done" for a date somebody already did, with nothing to undo', async () => {
		const c = await create();
		const result = await k.runner.invoke(
			'chores.markDone',
			{ id: c.id, dueDate: c.nextDue, label: 'Dishes' },
			{
				kind: 'ai',
				mode: 'conversation',
				source: 'assistant',
				onBehalfOf: ayse.id as never,
				roleId: 'admin',
			},
		);
		if (result.status !== 'drafted') throw new Error('expected a draft');
		const real = await done(c, bora.actor);
		expect(real.completion).not.toBeNull();

		const closed = await k.runner.approveDraft(result.draftId, ayse.actor);
		expect(closed.status).toBe('rejected');
		const [view] = await k
			.route('core.listDrafts')
			.call({ actor: ayse.actor, query: { limit: 5 } });
		expect(view).toMatchObject({ id: result.draftId, reason: 'settled', undoable: false });
		// Bora's completion stays: no second turn was recorded and none can be undone.
		const detail = await k
			.route('chores.getChore')
			.call({ params: { choreId: c.id }, actor: ayse.actor });
		expect(
			detail.history.filter((h: { undoneAt: number | null }) => h.undoneAt === null),
		).toHaveLength(1);
		expect(await rejected(k.runner.undoDraft(result.draftId, ayse.actor))).toBe('conflict');
	});

	it('lets the AI propose marking a chore done; approving does it and undo takes it back', async () => {
		const c = await create();
		const result = await k.runner.invoke(
			'chores.markDone',
			{ id: c.id, dueDate: c.nextDue, doneBy: bora.id, label: 'Dishes' },
			{
				kind: 'ai',
				mode: 'conversation',
				source: 'assistant',
				onBehalfOf: ayse.id as never,
				roleId: 'admin',
			},
			{ draft: { sourceKind: 'assistant', sourceId: 'turn_1' } },
		);
		expect(result.status).toBe('drafted');
		expect((await get(c.id)).nextDue).toBe(TODAY);
		await k.runner.approveDraft((result as { draftId: string }).draftId, ayse.actor);
		expect((await get(c.id)).nextDue).not.toBe(TODAY);
	});
});
