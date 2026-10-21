import { type Actor, defineAction, defineCapability, type MemberId } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CoreTables } from '../src/tables.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

// What a suggestion is called wherever it shows, and what its proposer hears when it is decided.
const pantryEdit = defineCapability({ id: 'pantry.edit', label: 'pantry:cap_edit', level: 'edit' });
const jars = new Map([['jar_1', 'Rice']]);
const pantry = defineTestExtension({
	id: 'pantry',
	capabilities: [pantryEdit],
	actions: [
		defineAction({
			id: 'pantry.share',
			title: 'Choose who shares a jar',
			draftTitle: 'pantry:draft_title_share',
			input: z.object({ id: z.string(), memberIds: z.array(z.string()) }),
			output: z.object({ id: z.string() }),
			approval: { unless: pantryEdit.id },
			// Only the id is sent; the jar's name comes from the record.
			async subject(_ctx, { id }) {
				return jars.get(id) ?? null;
			},
			ai: { description: 'Shares a jar.' },
			async run(_uow, { id }) {
				return { id };
			},
		}),
	],
});

type Who = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let parent: Who;
let kid: Who;
beforeEach(async () => {
	k = await createTestKernel({
		extensions: [pantry],
		translate: (_locale, key, params) => `${key} ${JSON.stringify(params ?? {})}`,
	});
	parent = await k.member('member');
	kid = await k.member('supervised');
});
afterEach(() => k.close());

const db = () => k.ctx.db.withTables<CoreTables>();
const propose = async (actor: Actor, id = 'jar_1') => {
	const result = await k.runner.invoke('pantry.share', { id, memberIds: [] }, actor);
	if (result.status !== 'drafted') throw new Error('expected a draft');
	return result;
};
const notices = async (kind: string) => {
	k.clock.advance(60_000);
	await k.worker.drain();
	return db().selectFrom('core_notifications').selectAll().where('kind', '=', kind).execute();
};
const view = async (who: Who) =>
	(await k.route('core.listDrafts').call({ actor: who.actor, query: { limit: 20 } })) as {
		id: string;
		subject: string | null;
		input: Record<string, unknown>;
	}[];

describe('the name of what a suggestion is about', () => {
	it('is stored with a draft that names its subject only by id', async () => {
		const result = await propose(kid.actor);
		expect(result).toMatchObject({ subject: 'Rice' });
		const [draft] = await view(parent);
		expect(draft?.input).toMatchObject({ id: 'jar_1', label: 'Rice' });
		expect(draft?.subject).toBe('Rice');
	});

	it('is read from the record for a draft stored without it', async () => {
		const { draftId } = await propose(kid.actor);
		await db()
			.updateTable('core_drafts')
			.set({ input: JSON.stringify({ id: 'jar_1', memberIds: [] }) })
			.where('id', '=', draftId)
			.execute();
		jars.set('jar_1', 'Brown rice');
		const [draft] = await view(parent);
		expect(draft?.subject).toBe('Brown rice');
		jars.set('jar_1', 'Rice');
	});

	it('reaches the approvers with who asked for it', async () => {
		await propose(kid.actor);
		const [note] = await notices('core.draftWaiting');
		expect(note?.body_key).toBe('app:notify_draft_waiting_named_by');
		expect(JSON.parse(note?.body_params ?? '{}')).toEqual({
			what: 'pantry:draft_title_share',
			name: 'Rice',
			who: kid.member.displayName,
		});
	});
});

describe('a suggestion from a connected app', () => {
	const appActor = (via?: MemberId): Actor =>
		via
			? {
					kind: 'member',
					memberId: via,
					roleId: 'supervised',
					via: { appId: 'app_home', appRoleId: 'supervised', mode: 'suggest' },
				}
			: { kind: 'app', appId: 'app_home', roleId: 'member', mode: 'suggest' };
	beforeEach(async () => {
		await db()
			.insertInto('core_apps')
			.values({
				id: 'app_home',
				name: 'Home Assistant',
				role_id: 'member',
				mode: 'suggest',
				acts_for: '[]',
				created_at: 0,
				updated_at: 0,
			})
			.execute();
	});

	it('reaches the approvers naming the app', async () => {
		await propose(appActor());
		const [note] = await notices('core.draftWaiting');
		expect(JSON.parse(note?.body_params ?? '{}')).toMatchObject({ who: 'Home Assistant' });
	});

	it('names the member and the app when it acts for someone', async () => {
		await propose(appActor(kid.member.id as MemberId));
		const [note] = await notices('core.draftWaiting');
		const { who } = JSON.parse(note?.body_params ?? '{}') as { who: string };
		expect(who).toContain(kid.member.displayName);
		expect(who).toContain('Home Assistant');
	});
});

describe('the answer to a suggestion', () => {
	it('tells the proposer who approved it, and what it was', async () => {
		const { draftId } = await propose(kid.actor);
		await k.runner.approveDraft(draftId, parent.actor);
		const decided = await notices('core.draftDecided');
		expect(decided).toHaveLength(1);
		expect(decided[0]).toMatchObject({
			member_id: kid.member.id,
			title_key: 'app:notify_draft_approved_title',
			body_key: 'app:notify_draft_waiting_named',
			url: '/add',
		});
		expect(JSON.parse(decided[0]?.title_params ?? '{}')).toEqual({
			name: parent.member.displayName,
		});
		expect(JSON.parse(decided[0]?.body_params ?? '{}')).toEqual({
			what: 'pantry:draft_title_share',
			name: 'Rice',
		});
	});

	it('tells the proposer who said no', async () => {
		const { draftId } = await propose(kid.actor);
		await k.runner.rejectDraft(draftId, parent.actor);
		const [note] = await notices('core.draftDecided');
		expect(note).toMatchObject({
			member_id: kid.member.id,
			title_key: 'app:notify_draft_rejected_title',
		});
	});

	it('tells the person a shared message was read for', async () => {
		const ai: Actor = {
			kind: 'ai',
			mode: 'share',
			source: 'inbox',
			onBehalfOf: kid.member.id as MemberId,
			roleId: kid.actor.roleId,
		};
		const { draftId } = await propose(ai);
		await k.runner.rejectDraft(draftId, parent.actor);
		const [note] = await notices('core.draftDecided');
		expect(note?.member_id).toBe(kid.member.id);
	});

	it('says nothing when the proposer takes it back themselves', async () => {
		const { draftId } = await propose(kid.actor);
		await k.runner.rejectDraft(draftId, kid.actor);
		expect(await notices('core.draftDecided')).toEqual([]);
	});
});
