import { type Actor, defineAction, defineCapability, type MemberId } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CORE_CAPABILITIES } from '../src/core-capabilities.ts';
import type { CoreTables, DraftRow } from '../src/tables.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

const shelfUse = defineCapability({ id: 'shelf.use', label: 'shelf:cap_use', level: 'use' });
const shelfManage = defineCapability({
	id: 'shelf.manage',
	label: 'shelf:cap_manage',
	level: 'edit',
});

const shelf = defineTestExtension({
	id: 'shelf',
	capabilities: [shelfUse, shelfManage],
	actions: [
		defineAction({
			id: 'shelf.tidy',
			title: 'Tidy the shelf',
			input: z.object({ note: z.string() }),
			output: z.object({ ok: z.boolean() }),
			requires: shelfUse.id,
			approval: { unless: shelfManage.id },
			async run() {
				return { ok: true };
			},
		}),
	],
});

type Who = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let admin: Who;
let kid: Who;
let otherKid: Who;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [shelf] });
	admin = await k.member('admin');
	kid = await k.member('supervised');
	otherKid = await k.member('supervised');
});
afterEach(() => k.close());

const aiFor = (who: Who): Actor => ({
	kind: 'ai',
	mode: 'agent',
	source: 'mcp',
	onBehalfOf: who.member.id as MemberId,
	roleId: who.actor.roleId,
});
const drafts = () => k.ctx.db.withTables<CoreTables>();

const propose = async (who: Actor, note: string) => {
	const made = await k.runner.invoke('shelf.tidy', { note }, who);
	if (made.status !== 'drafted') throw new Error('expected a draft');
	return made.draftId;
};

/** The SQL of every statement run while `work` runs. */
async function statements(work: () => Promise<unknown>): Promise<string[]> {
	const seen: string[] = [];
	const prepare = k.sqlite.prepare.bind(k.sqlite);
	k.sqlite.prepare = ((source: string) => {
		seen.push(source);
		return prepare(source);
	}) as typeof k.sqlite.prepare;
	try {
		await work();
	} finally {
		k.sqlite.prepare = prepare;
	}
	return seen;
}

type Query = { status?: DraftRow['status']; limit: number };
const list = (actor: Actor, query: Query) =>
	k.route('core.listDrafts').call({ actor, query }) as Promise<{ id: string; status: string }[]>;

/** The list as it was answered by reading every draft and filtering in memory. */
async function everythingRead(actor: Actor, query: Query) {
	const self = actor.kind === 'member' ? actor.memberId : null;
	let q = drafts()
		.selectFrom('core_drafts')
		.selectAll()
		.where((eb) =>
			self !== null
				? eb.or([eb('for_member', 'is', null), eb('for_member', '=', self)])
				: eb('for_member', 'is', null),
		);
	if (query.status) q = q.where('status', '=', query.status);
	const all = await q.orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
	const r = k.runner;
	const rows = (
		actor.kind === 'member'
			? all.filter(
					(row) =>
						r.mayDecide(row, actor) ||
						r.isProposer(actor, row) ||
						(r.unavailable(row) !== null &&
							k.access.can(actor, CORE_CAPABILITIES.draftsApprove.id)),
				)
			: all
	).slice(0, query.limit);
	const passed = await r.passedCheck();
	const gone = await r.goneAmong(rows.filter((row) => !passed(row)));
	return rows
		.map((row) => (passed(row) || gone.has(row.id) ? { ...row, status: 'expired' } : row))
		.filter((row) => !query.status || row.status === query.status)
		.map((row) => ({ id: row.id, status: row.status }));
}

describe('the list of suggestions', () => {
	it('answers as reading every draft would, over drafts the reader may and may not see', async () => {
		// A mix: the kid's, the other kid's, an AI's, decided ones, some made in the same instant,
		// and one addressed to the other kid alone.
		for (let i = 0; i < 70; i++) {
			const who = [kid.actor, otherKid.actor, aiFor(kid), aiFor(otherKid)][i % 4] as Actor;
			const id = await propose(who, `n${i}`);
			if (i % 7 === 0)
				await k.route('core.rejectDraft').call({ actor: admin.actor, params: { draftId: id } });
			else if (i % 11 === 0)
				await k
					.route('core.approveDraft')
					.call({ actor: admin.actor, params: { draftId: id }, body: {} });
			if (i % 13 === 0)
				await drafts()
					.updateTable('core_drafts')
					.set({ for_member: otherKid.member.id })
					.where('id', '=', id)
					.execute();
			if (i % 3 !== 0) k.clock.advance(1000);
		}
		for (const actor of [admin.actor, kid.actor, otherKid.actor, aiFor(kid)])
			for (const limit of [1, 3, 10, 60, 200])
				for (const status of [undefined, 'pending', 'rejected', 'applied'] as const) {
					const query = { limit, ...(status && { status }) };
					const answer = (await list(actor, query)).map((d) => ({ id: d.id, status: d.status }));
					expect(answer).toEqual(await everythingRead(actor, query));
				}
	});

	it('reads only a page of drafts when the first page fills the answer', async () => {
		for (let i = 0; i < 120; i++) {
			await propose(kid.actor, `n${i}`);
			k.clock.advance(1000);
		}
		const sql = (await statements(() => list(admin.actor, { limit: 5 }))).filter((s) =>
			/from "core_drafts"/.test(s),
		);
		expect(sql).toHaveLength(1);
		expect(sql[0]).toMatch(/limit \?/);
		expect(await list(admin.actor, { limit: 5 })).toHaveLength(5);
		// Nothing for this reader: every page is read, and the answer is still exact.
		expect(await list(otherKid.actor, { limit: 5 })).toEqual([]);
	});
});

describe('the count of waiting suggestions', () => {
	it('reads only what deciding and grouping need, never the stored texts', async () => {
		await propose(kid.actor, 'a');
		await propose(aiFor(kid), 'b');
		const sql = await statements(async () =>
			expect(await k.route('core.countWaitingDrafts').call({ actor: admin.actor })).toEqual({
				count: 2,
			}),
		);
		const read = sql.filter((s) => /from "core_drafts"/.test(s));
		expect(read).toHaveLength(1);
		expect(read[0]).not.toMatch(/select \*/);
		for (const column of ['summary', 'quote', 'result', 'error', 'uncertain_fields', 'replaced'])
			expect(read[0]).not.toContain(`"${column}"`);
	});
});
