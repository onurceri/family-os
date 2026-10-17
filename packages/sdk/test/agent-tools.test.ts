import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ActionInvoker } from '../src/index.ts';
import {
	agentInputSchema,
	createHandleTable,
	FamosError,
	idSchema,
	referenceId,
	refusalOf,
	refusalText,
	resolveReferences,
	runAgentTool,
	toolFailure,
	weekdayOf,
	withWeekdays,
} from '../src/index.ts';

const id = (prefix: string, n: number) =>
	`${prefix}_01990000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const schemaOf = (input: z.ZodType) =>
	z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;

const FIND = z.object({
	list: z.string().optional().describe('Only the list with this name'),
	listId: idSchema('shop_list').optional().describe('Only this list'),
	members: z.array(idSchema('member')).optional(),
	assignee: idSchema('member').nullable().optional(),
});

describe('the input schema an agent reads', () => {
	it('describes typed ids as references and never shows their pattern', () => {
		// gpt-4.1-mini read `^shop_list_[0-9a-f]{8}-…$` and wrote made-up ids that fit it
		// ("shop_list_00000000-0000-7000-8000-000000000000") instead of the handle it was given.
		const schema = agentInputSchema(schemaOf(FIND));
		const text = JSON.stringify(schema);
		expect(text).not.toContain('pattern');
		expect(text).not.toContain('[0-9a-f]');
		const properties = schema.properties as Record<string, Record<string, unknown>>;
		expect(properties.listId?.description).toMatch(/^Only this list\. A "shop_list:…" reference/);
		expect(properties.list).toEqual({
			type: 'string',
			description: 'Only the list with this name',
		});
		expect(JSON.stringify(properties.members)).toContain(`the person's name`);
		expect(JSON.stringify(properties.assignee)).toContain('member:…');
	});
});

describe('references from a model', () => {
	const table = createHandleTable();
	const sofia = id('member', 1);
	const noah = id('member', 2);
	const groceries = id('shop_list', 1);
	table.add('member', sofia);
	table.add('member', noah);
	table.add('shop_list', groceries);
	const people = [
		{ id: sofia, displayName: 'Sofia' },
		{ id: noah, displayName: 'Noah' },
	];
	const book = { table, people, locale: 'en' };

	it('reads a handle as models miswrite it, and a person by name', () => {
		expect(referenceId('member', 'member:2', book)).toBe(noah);
		// What gpt-4.1-mini wrote for member:2 and member:3.
		expect(referenceId('member', 'member_2', book)).toBe(noah);
		expect(referenceId('member', '2', book)).toBe(noah);
		expect(referenceId('member', 'Member 2', book)).toBe(noah);
		expect(referenceId('member', 'Noah', book)).toBe(noah);
		expect(referenceId('shop_list', 'shop_list_1', book)).toBe(groceries);
		expect(referenceId('member', sofia, book)).toBe(sofia);
		// Invented ones stay unknown.
		expect(referenceId('member', 'member:9', book)).toBeUndefined();
		expect(referenceId('member', 'Mila', book)).toBeUndefined();
		expect(referenceId('shop_list', id('shop_list', 7), book)).toBeUndefined();
		// A name is never read as a record other than a person.
		expect(referenceId('shop_list', 'Groceries', book)).toBeUndefined();
	});

	it('resolves the typed-id fields of an input, drops empty ones and names the invented ones', () => {
		const out = resolveReferences(
			{
				list: 'default',
				listId: '',
				members: ['Noah', 'member_1', ''],
				assignee: 'shop_list_00000000-0000-7000-8000-000000000000',
			},
			schemaOf(FIND),
			book,
		);
		expect(out.input).toEqual({
			list: 'default',
			members: [noah, sofia],
			assignee: 'shop_list_00000000-0000-7000-8000-000000000000',
		});
		expect(out.unknown).toEqual(['assignee']);
	});

	it('refuses an invented reference before the action runs, in the shared words', async () => {
		let ran = false;
		const actions = {
			async invoke() {
				ran = true;
				return { status: 'applied', output: {} };
			},
		} as unknown as ActionInvoker;
		const outcome = await runAgentTool({
			actions,
			actor: { kind: 'ai', mode: 'conversation', source: 'assistant' },
			table,
			actionId: 'lists.shoppingList',
			kind: 'read',
			input: { listId: 'shop_list:9' },
			draftTitle: 'Shopping',
			schema: schemaOf(FIND),
		});
		expect(ran).toBe(false);
		expect(outcome.ok).toBe(false);
		expect(outcome.text).toContain(
			"Error (unknown): what it names is not there. No such reference in 'listId'",
		);
	});
});

describe('refusals', () => {
	it('maps every failure to one reason', () => {
		expect(refusalOf(new FamosError('forbidden', 'no'))).toBe('not_allowed');
		expect(refusalOf(new FamosError('not_found', 'gone'))).toBe('unknown');
		expect(refusalOf(new FamosError('conflict', 'x', { refused: 'settled' }))).toBe('already');
		expect(refusalOf(new FamosError('conflict', 'x', { refused: 'other_target' }))).toBe('unknown');
		expect(refusalOf(new FamosError('bad_request', 'x', { properties: { id: {} } }))).toBe(
			'unknown',
		);
		expect(refusalOf(new FamosError('bad_request', 'Give `from`'))).toBe('incomplete');
	});

	it('words a failed tool call by its reason, without values or ids', () => {
		expect(toolFailure(new FamosError('forbidden', 'secret detail'))).toBe(
			'Error (not_allowed): not allowed for this person',
		);
		expect(toolFailure(new FamosError('not_found', `No event ${id('cal_event', 1)}`))).toBe(
			'Error (unknown): what it names is not there',
		);
		expect(
			toolFailure(
				new FamosError('conflict', 'That is Milk, not Oat milk', { refused: 'other_target' }),
			),
		).toBe('Error (unknown): what it names is not there. That is Milk, not Oat milk');
		expect(
			toolFailure(
				new FamosError('bad_request', 'invalid', {
					properties: { title: { errors: ['Required'] } },
				}),
			),
		).toBe('Error (incomplete): the input is incomplete or not valid. Fix: title: Required');
		expect(toolFailure(new FamosError('unavailable', 'try later'))).toBe('Error: try later');
		expect(refusalText('ambiguous')).toBe(
			'Error (ambiguous): several things fit; ask the person which one they mean',
		);
	});
});

describe('dates in results', () => {
	it('gives each date its weekday, worked out in code', () => {
		// A model told a child the bins go out "Monday 20 October": 20 October 2026 is a Tuesday.
		expect(
			withWeekdays({
				chores: [{ title: 'Take out the bins', nextDue: '2026-10-20', done: false }],
				nextAfter: { title: 'Inspection', dueDate: '2026-12-02', at: '2026-12-02T09:30' },
			}),
		).toEqual({
			chores: [
				{
					title: 'Take out the bins',
					nextDue: '2026-10-20',
					nextDueWeekday: 'Tuesday',
					done: false,
				},
			],
			nextAfter: {
				title: 'Inspection',
				dueDate: '2026-12-02',
				dueDateWeekday: 'Wednesday',
				at: '2026-12-02T09:30',
				atWeekday: 'Wednesday',
			},
		});
	});

	it('leaves what is no day, an instant, and objects that name their weekday', () => {
		expect(weekdayOf('2026-02-31')).toBeNull();
		expect(weekdayOf('2026-10-20T22:30:00Z')).toBeNull();
		expect(weekdayOf('Trip on 2026-10-20')).toBeNull();
		const event = { date: '2026-10-20', weekday: 'Tuesday' };
		expect(withWeekdays(event)).toEqual(event);
		const task = { dueDate: '2026-10-20', dueWeekday: 'Tuesday' };
		expect(withWeekdays(task)).toEqual(task);
		expect(withWeekdays(['2026-10-20'])).toEqual(['2026-10-20']);
	});
});
