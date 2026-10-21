import { isFamosError, systemActor } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notesExtension } from './fixtures.ts';
import { createTestKernel, type TestKernel } from './harness.ts';

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [notesExtension] });
});
afterEach(() => k.close());

const count = async () => {
	const r = await k.runner.invoke<{ count: number }>('notes.countNotes', {}, systemActor('test'));
	return r.status === 'applied' ? r.output.count : -1;
};

const codeOf = (promise: Promise<unknown>) =>
	promise.then(
		() => 'ok',
		(e: unknown) => (isFamosError(e) ? e.code : 'other'),
	);

describe('action runner', () => {
	it('applies an action for an allowed member and audits it', async () => {
		const { actor } = await k.member('member');
		const result = await k.runner.invoke('notes.addNote', { body: 'milk' }, actor);
		expect(result.status).toBe('applied');
		expect(await count()).toBe(1);
	});

	it('rejects invalid input, unknown actions and disallowed roles', async () => {
		const { actor: guest } = await k.member('guest');
		const { actor: member } = await k.member('member');
		expect(await codeOf(k.runner.invoke('notes.addNote', { body: '' }, member))).toBe(
			'bad_request',
		);
		expect(await codeOf(k.runner.invoke('notes.nope', {}, member))).toBe('not_found');
		expect(await codeOf(k.runner.invoke('notes.addNote', { body: 'x' }, guest))).toBe('forbidden');
	});

	it('turns AI proposals into drafts instead of applying them', async () => {
		const result = await k.runner.invoke(
			'notes.addNote',
			{ body: 'from AI' },
			{ kind: 'ai', mode: 'share', source: 'inbox' },
			{
				draft: { sourceKind: 'inbox_item', sourceId: 'x', summary: 'Add note' },
			},
		);
		expect(result.status).toBe('drafted');
		expect(await count()).toBe(0);
	});

	it('lets AI call read-only actions directly', async () => {
		const result = await k.runner.invoke(
			'notes.countNotes',
			{},
			{ kind: 'ai', mode: 'agent', source: 'agent' },
		);
		expect(result.status).toBe('applied');
	});

	it('lets people without the capability propose a draft instead', async () => {
		const { actor: supervised } = await k.member('supervised');
		const { actor: member } = await k.member('member');
		const { actor: guest } = await k.member('guest');
		expect((await k.runner.invoke('notes.share', { body: 'x' }, supervised)).status).toBe(
			'drafted',
		);
		expect((await k.runner.invoke('notes.share', { body: 'x' }, member)).status).toBe('applied');
		// Guests may not even propose.
		expect(await codeOf(k.runner.invoke('notes.share', { body: 'x' }, guest))).toBe('forbidden');
	});

	it('rolls back writes, jobs and events when the action throws', async () => {
		const { actor } = await k.member('admin');
		const events: string[] = [];
		k.bus.onAny((name) => {
			events.push(name);
		});
		await expect(
			k.runner.invoke('notes.addNote', { body: 'x', withJob: true, fail: true }, actor),
		).rejects.toThrow();
		expect(await count()).toBe(0);
		expect(await k.worker.drain()).toBe(0);
		expect(events).toEqual([]);
	});

	it('publishes events only after commit', async () => {
		const { actor } = await k.member('admin');
		const seen: number[] = [];
		k.bus.onAny(async (name) => {
			if (name === 'notes.item.added') seen.push(await count());
		});
		await k.runner.invoke('notes.addNote', { body: 'x' }, actor);
		expect(seen).toEqual([1]); // the handler already sees the committed row
	});
});

describe('drafts', () => {
	it('undoes an applied draft in one transaction; stale results are not undoable', async () => {
		const { actor: admin } = await k.member('admin');
		const ai = { kind: 'ai', mode: 'share', source: 'inbox' } as const;
		const first = await k.runner.invoke('notes.addNote', { body: 'a' }, ai);
		const second = await k.runner.invoke('notes.addNote', { body: 'b' }, ai);
		if (first.status !== 'drafted' || second.status !== 'drafted')
			throw new Error('expected drafts');
		const applied = await k.runner.approveDraft(first.draftId, admin);
		expect(k.runner.undoStep(applied)).toMatchObject({ actionId: 'notes.deleteNote' });
		expect(await count()).toBe(1);
		expect((await k.runner.undoDraft(first.draftId, admin)).status).toBe('undone');
		expect(await count()).toBe(0);
		await expect(k.runner.undoDraft(second.draftId, admin)).rejects.toMatchObject({
			code: 'conflict',
		}); // pending

		// A result stored by an older version, in a shape the action no longer returns.
		const old = await k.runner.approveDraft(second.draftId, admin);
		expect(k.runner.undoStep({ ...old, result: JSON.stringify({ legacy: true }) })).toBeNull();
		const list = await k.route('core.listDrafts').call({ query: { limit: 50 } });
		expect(list.map((d: { status: string; undoable: boolean }) => [d.status, d.undoable])).toEqual(
			expect.arrayContaining([
				['undone', false],
				['applied', true],
			]),
		);
	});

	it('suggests an undone draft again for the person behind it, once', async () => {
		const { actor: admin } = await k.member('admin');
		const { actor: kid } = await k.member('supervised');
		const drafted = await k.runner.invoke('notes.addNote', { body: 'a' }, kid, {
			draft: { sourceKind: 'inbox', sourceId: 'inbox_item_1', summary: 'A note' },
		});
		if (drafted.status !== 'drafted') throw new Error('expected a draft');
		await k.runner.approveDraft(drafted.draftId, admin);
		await k.runner.undoDraft(drafted.draftId, admin);

		// Approving it again is refused, and the refusal says what can be done instead.
		const refused = await k.runner.approveDraft(drafted.draftId, admin).catch((e: unknown) => e);
		expect(refused).toMatchObject({
			code: 'conflict',
			details: { status: 'undone', next: 'core.suggestDraftAgain' },
		});
		expect((refused as Error).message).toContain('suggest it again');

		// Only the person who suggested it sends it again.
		expect(await codeOf(k.runner.suggestAgain(drafted.draftId, admin))).toBe('forbidden');
		const again = await k.route('core.suggestDraftAgain').call({
			params: { draftId: drafted.draftId },
			actor: kid,
		});
		expect(again).toMatchObject({
			status: 'pending',
			actionId: 'notes.addNote',
			input: { body: 'a' },
			sourceKind: 'inbox',
			sourceId: 'inbox_item_1',
			summary: 'A note',
			proposedBy: { kind: 'member', memberId: kid.memberId },
		});
		expect(again.id).not.toBe(drafted.draftId);
		const undone = await k.route('core.listDrafts').call({
			query: { status: 'undone', limit: 50 },
			actor: kid,
		});
		expect(undone).toMatchObject([{ id: drafted.draftId, suggestedAgain: true }]);
		// Asking twice gives the same new suggestion.
		expect((await k.runner.suggestAgain(drafted.draftId, kid)).id).toBe(again.id);
		// The new one is not undone: it is decided like any other.
		expect(await codeOf(k.runner.suggestAgain(again.id, kid))).toBe('conflict');
		await k.runner.approveDraft(again.id, admin);
		expect(await count()).toBe(1);
	});

	it('drafts once per dedupe key and filters drafts by source', async () => {
		const ai = { kind: 'ai', mode: 'share', source: 'inbox' } as const;
		const meta = { sourceKind: 'inbox', sourceId: 'inbox_item_1', dedupeKey: 'inbox:1:0' };
		const first = await k.runner.invoke('notes.addNote', { body: 'a' }, ai, { draft: meta });
		const again = await k.runner.invoke('notes.addNote', { body: 'a' }, ai, { draft: meta });
		if (first.status !== 'drafted' || again.status !== 'drafted')
			throw new Error('expected drafts');
		expect(again.draftId).toBe(first.draftId);
		await k.runner.invoke('notes.addNote', { body: 'b' }, ai);
		const list = k.route('core.listDrafts');
		expect(await list.call({ query: { limit: 50 } })).toHaveLength(2);
		expect(await list.call({ query: { sourceKind: 'inbox', limit: 50 } })).toEqual([
			expect.objectContaining({ id: first.draftId, sourceId: 'inbox_item_1' }),
		]);
	});

	it('applies an approved draft once (idempotent) with edited input', async () => {
		const { actor: admin } = await k.member('admin');
		const result = await k.runner.invoke(
			'notes.addNote',
			{ body: 'draft' },
			{ kind: 'ai', mode: 'share', source: 'inbox' },
		);
		if (result.status !== 'drafted') throw new Error('expected draft');

		const applied = await k.runner.approveDraft(result.draftId, admin, { body: 'edited' });
		expect(applied.status).toBe('applied');
		expect(JSON.parse(applied.edited_input ?? 'null')).toEqual({ body: 'edited' });
		const again = await k.runner.approveDraft(result.draftId, admin);
		expect(again.status).toBe('applied');
		expect(await count()).toBe(1);
	});

	it('lets anyone who may approve and make the change decide drafts, not only admins', async () => {
		const { actor: supervised } = await k.member('supervised');
		const { actor: member } = await k.member('member');
		const result = await k.runner.invoke(
			'notes.addNote',
			{ body: 'x' },
			{ kind: 'ai', mode: 'share', source: 'inbox' },
		);
		if (result.status !== 'drafted') throw new Error('expected draft');
		expect(await codeOf(k.runner.approveDraft(result.draftId, supervised))).toBe('forbidden');
		expect(await codeOf(k.runner.rejectDraft(result.draftId, supervised))).toBe('forbidden');
		// An adult member (not an admin) approves.
		expect((await k.runner.approveDraft(result.draftId, member)).status).toBe('applied');
	});

	it('rejects drafts and refuses to apply them afterwards', async () => {
		const { actor: admin } = await k.member('admin');
		const result = await k.runner.invoke('notes.purge', {}, admin); // approval: always
		if (result.status !== 'drafted') throw new Error('expected draft');
		expect((await k.runner.rejectDraft(result.draftId, admin)).status).toBe('rejected');
		expect(await codeOf(k.runner.approveDraft(result.draftId, admin))).toBe('conflict');
	});

	it('marks a draft failed on unexpected errors and keeps it pending on domain errors', async () => {
		const { actor: admin } = await k.member('admin');
		const failing = await k.runner.invoke(
			'notes.addNote',
			{ body: 'x', fail: true },
			{ kind: 'ai', mode: 'share', source: 'inbox' },
		);
		if (failing.status !== 'drafted') throw new Error('expected draft');
		// A draft that failed changed state for readers too, and the change log hears of it.
		const seen = await k.changes.head();
		expect(await codeOf(k.runner.approveDraft(failing.draftId, admin))).toBe('unavailable');
		expect((await k.changes.since(seen, admin)).changes.map((c) => [c.entity, c.id, c.op])).toEqual(
			[['draft', failing.draftId, 'upsert']],
		);

		const domain = await k.runner.invoke(
			'notes.conflict',
			{},
			{ kind: 'ai', mode: 'share', source: 'inbox' },
		);
		if (domain.status !== 'drafted') throw new Error('expected draft');
		expect(await codeOf(k.runner.approveDraft(domain.draftId, admin))).toBe('conflict');

		const rows = await k.ctx.db
			.withTables<import('../src/tables.ts').CoreTables>()
			.selectFrom('core_drafts')
			.select(['id', 'status'])
			.execute();
		const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
		expect(status[failing.draftId]).toBe('failed');
		expect(status[domain.draftId]).toBe('pending');
	});
});
