import {
	type Actor,
	defineAction,
	defineCapability,
	defineMentionKind,
	type ExtensionDefinition,
	type IndexedMention,
	type MentionContext,
	type MentionEnv,
	type MentionKindDefinition,
	type Resolution,
	systemActor,
} from '@famos/sdk';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildRegistry } from '../src/registry.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

// A small extension with notes in its own table, one AI action and one mention kind whose
// resolver a test can replace.
type NotesTables = { notes_items: { id: string; title: string } };

const notesEdit = defineCapability({ id: 'notes.edit', label: 'notes:cap', level: 'edit' });
const addNote = defineAction({
	id: 'notes.addNote',
	title: 'Add a note',
	input: z.object({ title: z.string().min(1) }),
	output: z.object({}),
	approval: { unless: notesEdit.id },
	ai: { description: 'Adds a note.' },
	async run() {
		return {};
	},
});
const purge = defineAction({
	id: 'notes.purge',
	title: 'Purge',
	input: z.object({}),
	output: z.object({}),
	requires: notesEdit.id,
	async run() {
		return {};
	},
});
const listNotes = defineAction({
	id: 'notes.context',
	title: 'Notes for the AI',
	input: z.object({}),
	output: z.object({}),
	readOnly: true,
	async run() {
		return {};
	},
});

type Resolver = MentionKindDefinition['resolve'];
let resolver: Resolver = async () => [];

const noteKind = (extra: Partial<MentionKindDefinition> = {}): MentionKindDefinition =>
	defineMentionKind({
		id: 'notes.note',
		describe: 'Something to write down.',
		slots: { title: 'What to write down', date: 'When it is about', people: 'Who it is for' },
		actions: ['notes.addNote'],
		examples: [
			{
				text: 'Note: call the plumber on Friday',
				mentions: [
					{
						kind: 'notes.note',
						quote: 'call the plumber on Friday',
						title: 'Call the plumber',
						date: { text: 'Friday', weekday: 5 },
					},
				],
			},
		],
		resolve: (ctx, mentions) => resolver(ctx, mentions),
		...extra,
	});

const notes = (kinds: MentionKindDefinition[] = [noteKind()], extra: object = {}) =>
	defineTestExtension({
		id: 'notes',
		capabilities: [notesEdit],
		actions: [addNote, purge, listNotes],
		migrations: {
			'0001_items': {
				up: (db) =>
					db.schema
						.createTable('notes_items')
						.addColumn('id', 'text', (c) => c.primaryKey())
						.addColumn('title', 'text', (c) => c.notNull())
						.execute(),
			},
		},
		ai: { context: 'notes.context', kinds },
		...extra,
	});

const AI: Actor = { kind: 'ai', mode: 'share', source: 'inbox' };
const ENV: MentionEnv = { text: 'Note: call the plumber', sharer: null, records: [] };
const at = (...mentions: IndexedMention['mention'][]): IndexedMention[] =>
	mentions.map((mention, index) => ({ index, mention }));
const note = (title: string) => ({ kind: 'notes.note', title });
const propose = (from: number[], title = 'x'): Resolution => ({
	propose: { actionId: 'notes.addNote', input: { title }, subject: title, from },
});

let k: TestKernel;
afterEach(async () => {
	resolver = async () => [];
	await k?.close();
});
const start = async (extensions: ExtensionDefinition[] = [notes()]) => {
	k = await createTestKernel({ extensions });
};
const setArea = (extensionId: string, access: 'off' | 'local' | 'any') =>
	k.runner.invoke(
		'core.setAiAreaAccess',
		{ extensionId, access, confirmSensitive: true },
		systemActor('test'),
	);

describe('which kinds the AI may read', () => {
	it('offers a kind with what the model needs, and not its resolver', async () => {
		await start();
		const [info] = k.ctx.actions.aiKinds();
		expect(info).toEqual({
			id: 'notes.note',
			extension: 'notes',
			describe: 'Something to write down.',
			slots: { title: 'What to write down', date: 'When it is about', people: 'Who it is for' },
			examples: noteKind().examples,
			limit: 16,
		});
		expect(info).not.toHaveProperty('resolve');
	});

	it('offers no kind of an area that is off for the AI, or local-only to a model that is not', async () => {
		await start();
		await setArea('notes', 'off');
		expect(k.ctx.actions.aiKinds()).toEqual([]);
		await setArea('notes', 'local');
		expect(k.ctx.actions.aiKinds()).toEqual([]);
		expect(k.ctx.actions.aiKinds({ local: true }).map((i) => i.id)).toEqual(['notes.note']);
	});

	it('offers no kind of an extension that is turned off', async () => {
		await start();
		await k.runner.invoke(
			'core.setFeatureEnabled',
			{ extensionId: 'notes', enabled: false },
			systemActor('test'),
		);
		expect(k.ctx.actions.aiKinds()).toEqual([]);
	});

	it('offers a kind only while all its actions are offered: a foreign one turned off hides it', async () => {
		const tasksEdit = defineCapability({ id: 'tasks.edit', label: 'tasks:cap', level: 'edit' });
		const addTask = defineAction({
			id: 'tasks.addTask',
			title: 'Add a task',
			input: z.object({ title: z.string() }),
			output: z.object({}),
			approval: { unless: tasksEdit.id },
			ai: { description: 'Adds a task.' },
			async run() {
				return {};
			},
		});
		const tasks = defineTestExtension({
			id: 'tasks',
			capabilities: [tasksEdit],
			actions: [addTask],
		});
		await start([
			tasks,
			notes([noteKind({ actions: ['notes.addNote', 'tasks.addTask'] })], {
				optional: ['tasks'],
				calls: ['tasks.addTask'],
			}),
		]);
		expect(k.ctx.actions.aiKinds().map((i) => i.id)).toEqual(['notes.note']);
		await setArea('tasks', 'off');
		expect(k.ctx.actions.aiKinds()).toEqual([]);
	});

	it('for an AI working for a member, offers only kinds whose actions that member may propose', async () => {
		await start();
		const { actor: guest } = await k.member('guest');
		const forGuest: Actor = { ...AI, onBehalfOf: guest.memberId, roleId: 'guest' };
		const { actor: admin } = await k.member('admin');
		const forAdmin: Actor = { ...AI, onBehalfOf: admin.memberId, roleId: 'admin' };
		expect(k.ctx.actions.aiKinds({ actor: forGuest })).toEqual([]);
		expect(k.ctx.actions.aiKinds({ actor: forAdmin }).map((i) => i.id)).toEqual(['notes.note']);
	});
});

describe('resolving mentions', () => {
	it('gives the resolver the reading, the family formats and its own tables', async () => {
		await start();
		let seen: MentionContext | undefined;
		resolver = async (ctx, mentions) => {
			seen = ctx;
			const rows = await ctx.db
				.withTables<NotesTables>()
				.selectFrom('notes_items')
				.selectAll()
				.execute();
			return [propose([mentions[0]?.index ?? 0], `rows ${rows.length}`)];
		};
		const out = await k.ctx.actions.resolveMentions('notes.note', at(note('Call')), ENV, AI);
		expect(out).toEqual([propose([0], 'rows 0')]);
		expect(seen).toMatchObject({
			today: '2026-01-01',
			timeZone: 'UTC',
			weekStart: 1,
			locale: 'en',
			text: ENV.text,
			sharer: null,
			records: [],
		});
	});

	it('lets a resolver only read: a write is refused and its mentions are left out', async () => {
		await start();
		resolver = async (ctx, mentions) => {
			await ctx.db
				.withTables<NotesTables>()
				.insertInto('notes_items')
				.values({ id: 'n1', title: 'sneaked in' })
				.execute();
			return [propose(mentions.map((m) => m.index))];
		};
		const out = await k.ctx.actions.resolveMentions('notes.note', at(note('Call')), ENV, AI);
		expect(out).toEqual([{ refuse: { reason: 'incomplete', subject: 'Call', from: [0] } }]);
		const rows = await k.ctx.db
			.withTables<NotesTables>()
			.selectFrom('notes_items')
			.selectAll()
			.execute();
		expect(rows).toEqual([]);
	});

	it('refuses raw SQL that writes, and lets raw SQL that reads through', async () => {
		await start();
		const steps: string[] = [];
		resolver = async (ctx) => {
			const read = await sql<{ n: number }>`select count(*) as n from notes_items`.execute(ctx.db);
			steps.push(`read ${read.rows[0]?.n}`);
			await sql`delete from notes_items`.execute(ctx.db).catch((error: { code?: string }) => {
				steps.push(`write ${error.code}`);
			});
			return [];
		};
		await k.ctx.actions.resolveMentions('notes.note', at(note('A')), ENV, AI);
		expect(steps).toEqual(['read 0', 'write forbidden']);
	});

	it('is only for the AI, and only while the kind is offered', async () => {
		await start();
		const { actor } = await k.member('admin');
		await expect(
			k.ctx.actions.resolveMentions('notes.note', at(note('A')), ENV, actor),
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(
			k.ctx.actions.resolveMentions('notes.nothing', at(note('A')), ENV, AI),
		).rejects.toMatchObject({ code: 'forbidden' });
		await setArea('notes', 'local');
		await expect(
			k.ctx.actions.resolveMentions('notes.note', at(note('A')), ENV, AI),
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(
			k.ctx.actions.resolveMentions('notes.note', at(note('A')), ENV, { ...AI, local: true }),
		).resolves.toHaveLength(1);
	});

	it('takes only mentions of the kind, with distinct indexes, and not too many', async () => {
		await start();
		const resolve = (mentions: IndexedMention[]) =>
			k.ctx.actions.resolveMentions('notes.note', mentions, ENV, AI);
		await expect(resolve([{ index: 0, mention: { kind: 'other.kind' } }])).rejects.toMatchObject({
			code: 'bad_request',
		});
		await expect(
			resolve([
				{ index: 1, mention: note('A') },
				{ index: 1, mention: note('B') },
			]),
		).rejects.toMatchObject({ code: 'bad_request' });
		await expect(
			resolve(Array.from({ length: 17 }, (_, index) => ({ index, mention: note(`N${index}`) }))),
		).rejects.toMatchObject({ code: 'bad_request' });
	});

	it('never lets one mention back more than one suggestion', async () => {
		await start();
		// Injected text read as one mention tries to become eleven suggestions.
		resolver = async () => Array.from({ length: 11 }, (_, i) => propose([0], `Test ${i}`));
		const out = await k.ctx.actions.resolveMentions('notes.note', at(note('Test')), ENV, AI);
		expect(out).toEqual([propose([0], 'Test 0')]);
	});

	it('drops resolutions that name no mention or one it was not given', async () => {
		await start();
		resolver = async () => [propose([]), propose([7]), propose([1])];
		const out = await k.ctx.actions.resolveMentions(
			'notes.note',
			at(note('A'), note('B')),
			ENV,
			AI,
		);
		expect(out).toEqual([
			{ refuse: { reason: 'incomplete', subject: 'A', from: [0] } },
			propose([1]),
		]);
	});

	it('lets a resolver merge mentions into one suggestion', async () => {
		await start();
		resolver = async (_ctx, mentions) => [propose(mentions.map((m) => m.index).reverse(), 'All')];
		const out = await k.ctx.actions.resolveMentions(
			'notes.note',
			at(note('A'), note('B'), note('C')),
			ENV,
			AI,
		);
		expect(out).toEqual([propose([0, 1, 2], 'All')]);
	});

	it('refuses a suggestion of an action the kind does not name', async () => {
		await start();
		resolver = async () => [
			{ propose: { actionId: 'notes.purge', input: {}, subject: 'Everything', from: [0] } },
		];
		const out = await k.ctx.actions.resolveMentions('notes.note', at(note('A')), ENV, AI);
		expect(out).toEqual([{ refuse: { reason: 'incomplete', subject: 'Everything', from: [0] } }]);
	});

	it('refuses mentions beyond the kind’s limit before the resolver sees them', async () => {
		await start([notes([noteKind({ limit: 2 })])]);
		let given: readonly IndexedMention[] = [];
		resolver = async (_ctx, mentions) => {
			given = mentions;
			return mentions.map((m) => propose([m.index], m.mention.title));
		};
		const out = await k.ctx.actions.resolveMentions(
			'notes.note',
			[
				{ index: 3, mention: note('D') },
				{ index: 0, mention: note('A') },
				{ index: 2, mention: note('C') },
			],
			ENV,
			AI,
		);
		expect(given.map((m) => m.index)).toEqual([0, 2]);
		expect(out).toEqual([
			propose([0], 'A'),
			propose([2], 'C'),
			{ refuse: { reason: 'incomplete', subject: 'D', from: [3] } },
		]);
	});

	it('keeps refusals with their reason and subject, and the marks of a suggestion', async () => {
		await start();
		resolver = async () => [
			{ refuse: { reason: 'ambiguous', subject: ' Football ', from: [1] } },
			{
				propose: {
					actionId: 'notes.addNote',
					input: { title: 'Call' },
					subject: 'Call',
					targetTitle: 'Call the plumber',
					uncertain: ['title', 'title'],
					from: [0],
				},
			},
			{ refuse: { reason: 'made_up' as 'unknown', subject: null, from: [2] } },
		];
		const out = await k.ctx.actions.resolveMentions(
			'notes.note',
			at(note('Call'), note('Football'), note('X')),
			ENV,
			AI,
		);
		expect(out).toEqual([
			{
				propose: {
					actionId: 'notes.addNote',
					input: { title: 'Call' },
					subject: 'Call',
					targetTitle: 'Call the plumber',
					uncertain: ['title'],
					from: [0],
				},
			},
			{ refuse: { reason: 'ambiguous', subject: 'Football', from: [1] } },
			{ refuse: { reason: 'incomplete', subject: null, from: [2] } },
		]);
	});

	it('marks every field a resolver defaulted or inferred, and none it wrote or matched', async () => {
		await start([
			notes([noteKind({ decides: { date: 'inferred', 'items.*.list': 'defaulted' } })]),
		]);
		resolver = async () => [
			{
				propose: {
					actionId: 'notes.addNote',
					input: { title: 'Call' },
					subject: 'Call',
					uncertain: ['title'],
					decided: {
						title: 'written',
						target: 'matched',
						date: 'inferred',
						'items.0.list': 'defaulted',
					},
					from: [0],
				},
			},
		];
		const [out] = await k.ctx.actions.resolveMentions('notes.note', at(note('Call')), ENV, AI);
		expect(out).toMatchObject({
			propose: { uncertain: ['title', 'date', 'items.0.list'] },
		});
		expect(JSON.stringify(out)).not.toContain('decided');
	});

	it('marks a decided field its kind did not declare as well, so a guess is never silent', async () => {
		await start([notes([noteKind({ decides: {} })])]);
		resolver = async () => [
			{
				propose: {
					actionId: 'notes.addNote',
					input: { title: 'Call' },
					subject: 'Call',
					decided: { date: 'defaulted' },
					from: [0],
				},
			},
		];
		const [out] = await k.ctx.actions.resolveMentions('notes.note', at(note('Call')), ENV, AI);
		expect(out).toMatchObject({ propose: { uncertain: ['date'] } });
	});

	it('refuses every mention when the resolver fails', async () => {
		await start();
		resolver = async () => {
			throw new Error('bug');
		};
		const out = await k.ctx.actions.resolveMentions(
			'notes.note',
			at(note('A'), { kind: 'notes.note', target: 'B' }),
			ENV,
			AI,
		);
		expect(out).toEqual([
			{ refuse: { reason: 'incomplete', subject: 'A', from: [0] } },
			{ refuse: { reason: 'incomplete', subject: 'B', from: [1] } },
		]);
	});

	it('binds the day, time, people, target and record helpers to the reading', async () => {
		await start();
		const { member } = await k.member('admin');
		let ctx: MentionContext | undefined;
		resolver = async (c) => {
			ctx = c;
			return [];
		};
		await k.ctx.actions.resolveMentions(
			'notes.note',
			at(note('A')),
			{
				text: `${member.displayName} takes the blue car to the garage on Friday`,
				sharer: member.id,
				records: [
					{ kind: 'vehicle', id: 'v1', label: 'Blue car' },
					{ kind: 'vehicle', id: 'v2', label: 'Red van' },
					{ kind: 'pet', id: 'p1', label: 'Blue' },
				],
			},
			AI,
		);
		if (!ctx) throw new Error('resolver not called');
		// 2026-01-01 is a Thursday.
		expect(ctx.day({ text: 'Friday', weekday: 5 })).toEqual({
			date: '2026-01-02',
			certain: false,
			why: 'weekday_only',
		});
		expect(ctx.day({ text: 'yesterday', inDays: -1 }, 'past')).toMatchObject({
			date: '2025-12-31',
			certain: true,
		});
		expect(ctx.time({ time: '16:00', timeText: '4:30 pm' })).toEqual({
			time: '16:30',
			certain: true,
		});
		// The default region is a 12-hour clock: a bare hour is a guess.
		expect(ctx.time({ time: '04:00', timeText: 'at 4' })).toEqual({
			time: '04:00',
			certain: false,
		});
		expect(ctx.time({})).toBeNull();
		expect(ctx.people({ forMe: true })).toEqual({ ids: [member.id], certain: true, unmatched: [] });
		expect(ctx.people({ people: ['Nobody'] }).unmatched).toEqual(['Nobody']);
		expect(ctx.target('the garage', [{ label: 'Garage' }, { label: 'Dentist' }])).toEqual({
			found: { label: 'Garage' },
		});
		expect(ctx.record('the blue car', ['vehicle'])).toEqual({
			found: { kind: 'vehicle', id: 'v1', label: 'Blue car' },
		});
		expect(ctx.record('the red van')).toEqual({ none: true });
	});
});

describe('the registry holds kinds to their extension', () => {
	const build = (ext: ExtensionDefinition) => () => buildRegistry([ext]);
	const refused = (kinds: MentionKindDefinition[], extra: object = {}) =>
		build(notes(kinds, extra));

	it('takes a well-formed kind', () => {
		expect(build(notes())).not.toThrow();
	});

	it('refuses an id twice', () => {
		expect(refused([noteKind(), noteKind()])).toThrow(/Duplicate mention kind "notes.note"/);
	});

	it('refuses an example that does not read as a mention, or fills a slot the kind lacks', () => {
		expect(
			refused([
				noteKind({
					examples: [
						{
							text: 'x',
							mentions: [{ kind: 'notes.note', quote: 'x', title: 5 as unknown as string }],
						},
					],
				}),
			]),
		).toThrow(/does not read as a mention/);
		expect(
			refused([
				noteKind({
					examples: [{ text: 'x', mentions: [{ kind: 'notes.note', quote: 'x', place: 'Home' }] }],
				}),
			]),
		).toThrow(/fills "place"/);
	});

	it('refuses an action it does not own and does not call, or one the AI cannot propose', () => {
		expect(refused([noteKind({ actions: ['tasks.addTask'] })])).toThrow(
			/neither its own nor in its manifest's calls/,
		);
		expect(refused([noteKind({ actions: ['notes.missing'] })])).toThrow(/which "notes" lacks/);
		expect(refused([noteKind({ actions: ['notes.purge'] })])).toThrow(/the AI cannot propose/);
		expect(refused([noteKind({ actions: ['notes.context'] })])).toThrow(/the AI cannot propose/);
	});

	it('refuses known names from an action that is not its AI context', () => {
		expect(refused([noteKind({ knownFrom: ['notes.addNote'] })])).toThrow(
			/not one of its AI context actions/,
		);
		expect(build(notes([noteKind({ knownFrom: ['notes.context'] })]))).not.toThrow();
	});

	it('refuses a kind named for another extension', () => {
		const kind = noteKind({ id: 'tasks.note' });
		const ext = { ...notes(), ai: { kinds: [kind] } } as ExtensionDefinition;
		expect(build(ext)).toThrow(/must be namespaced as "notes.<name>"/);
		expect(() => notes([kind])).toThrow(/must be namespaced/);
	});

	it('refuses a hand-off to a kind of an extension its manifest does not name', () => {
		expect(refused([noteKind({ handsOff: ['agenda.item'] })])).toThrow(
			/hands mentions to "agenda.item", but "agenda" is neither a dependency nor optional/,
		);
		expect(
			build(notes([noteKind({ handsOff: ['agenda.item'] })], { optional: ['agenda'] })),
		).not.toThrow();
	});
});

describe('a mention handed to another kind', () => {
	// An agenda whose kind takes what a note is not: something that happens at a time.
	const agendaEdit = defineCapability({ id: 'agenda.edit', label: 'agenda:cap', level: 'edit' });
	const addItem = defineAction({
		id: 'agenda.addItem',
		title: 'Add to the agenda',
		input: z.object({ title: z.string().min(1) }),
		output: z.object({}),
		approval: { unless: agendaEdit.id },
		ai: { description: 'Adds to the agenda.' },
		async run() {
			return {};
		},
	});
	let agendaResolver: Resolver = async (_ctx, mentions) =>
		mentions.map(({ index, mention }) => ({
			propose: {
				actionId: 'agenda.addItem',
				input: { title: mention.title },
				subject: mention.title ?? null,
				from: [index],
			},
		}));
	const agenda = () =>
		defineTestExtension({
			id: 'agenda',
			capabilities: [agendaEdit],
			actions: [addItem],
			ai: {
				kinds: [
					defineMentionKind({
						id: 'agenda.item',
						describe: 'Something at a time.',
						slots: { title: 'What', time: 'When' },
						actions: ['agenda.addItem'],
						handsOff: ['notes.note'],
						examples: [
							{
								text: 'Dentist at 4',
								mentions: [{ kind: 'agenda.item', quote: 'Dentist at 4', title: 'Dentist' }],
							},
						],
						resolve: (ctx, mentions) => agendaResolver(ctx, mentions),
					}),
				],
			},
			optional: ['notes'],
		});
	const handing = notes([noteKind({ handsOff: ['agenda.item'] })], { optional: ['agenda'] });
	const handOff = (from: number[], title = 'Dentist'): Resolution => ({
		handOff: { kind: 'agenda.item', mention: { kind: 'notes.note', title, time: '16:00' }, from },
	});
	afterEach(() => {
		agendaResolver = async (_ctx, mentions) =>
			mentions.map(({ index, mention }) => ({
				propose: {
					actionId: 'agenda.addItem',
					input: { title: mention.title },
					subject: mention.title ?? null,
					from: [index],
				},
			}));
	});

	it('is resolved by that kind, as the mention it was given', async () => {
		await start([handing, agenda()]);
		let seen: IndexedMention[] = [];
		const resolveAgenda = agendaResolver;
		agendaResolver = async (ctx, mentions) => {
			seen = [...mentions];
			return resolveAgenda(ctx, mentions);
		};
		resolver = async () => [handOff([0])];
		const out = await k.ctx.actions.resolveMentions('notes.note', at(note('Dentist')), ENV, AI);
		expect(seen).toEqual([
			{ index: 0, mention: { kind: 'agenda.item', title: 'Dentist', time: '16:00' } },
		]);
		expect(out).toEqual([
			{
				propose: {
					actionId: 'agenda.addItem',
					input: { title: 'Dentist' },
					subject: 'Dentist',
					from: [0],
				},
			},
		]);
	});

	it('is refused as incomplete when that kind is not there, not named, or hands it on again', async () => {
		await start([handing]);
		resolver = async () => [handOff([0])];
		expect(await k.ctx.actions.resolveMentions('notes.note', at(note('A')), ENV, AI)).toEqual([
			{ refuse: { reason: 'incomplete', subject: 'Dentist', from: [0] } },
		]);
		await k.close();

		await start([notes(), agenda()]);
		resolver = async () => [handOff([0])];
		expect(await k.ctx.actions.resolveMentions('notes.note', at(note('A')), ENV, AI)).toEqual([
			{ refuse: { reason: 'incomplete', subject: null, from: [0] } },
		]);
		await k.close();

		await start([handing, agenda()]);
		resolver = async () => [handOff([0])];
		agendaResolver = async () => [
			{ handOff: { kind: 'notes.note', mention: { kind: 'agenda.item' }, from: [0] } },
		];
		expect(await k.ctx.actions.resolveMentions('notes.note', at(note('A')), ENV, AI)).toEqual([
			{ refuse: { reason: 'incomplete', subject: 'Dentist', from: [0] } },
		]);
	});

	it('is one mention at a time', async () => {
		await start([handing, agenda()]);
		resolver = async () => [handOff([0, 1])];
		expect(
			await k.ctx.actions.resolveMentions('notes.note', at(note('A'), note('B')), ENV, AI),
		).toEqual([{ refuse: { reason: 'incomplete', subject: null, from: [0, 1] } }]);
	});
});
