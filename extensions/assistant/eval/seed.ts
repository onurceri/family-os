import { type AiAreaAccess, systemActor } from '@famos/sdk';
import type { TestKernel } from '@famos/testing';
import type { Recurrence } from '@famos/time';
import { epochOf } from '@famos/time';
import type { Check, Seeded } from './checks.ts';

/**
 * What a case puts in the household before it asks, and whom it asks as. Seeding needs no model,
 * so it is tested on its own.
 */
export interface Person {
	name: string;
	roleId: string;
	about?: string;
}

export interface SeedEvent {
	title: string;
	date: string;
	startTime: string;
	endTime?: string;
	/** Display names of the members it concerns; none means the whole family. */
	who?: string[];
	recurrence?: Recurrence;
	location?: string;
	/** The event's tags; they become the family's tags. */
	tags?: string[];
}

export interface SeedTask {
	title: string;
	dueDate?: string;
	/** Display name of the member it is assigned to. */
	who?: string;
}

export interface SeedItem {
	title: string;
	quantity?: string;
	/** Already bought (ticked off). */
	bought?: boolean;
}

export interface Case {
	name: string;
	/** The messages of the conversation, in order, in one thread. */
	asks: string[];
	/** Who asks; the first person of the family by default. */
	as?: string;
	/** A different household for this case. */
	family?: Person[];
	/** The family time zone (IANA). */
	timeZone?: string;
	/** The family language. */
	locale?: string;
	events?: SeedEvent[];
	/** Shopping lists by name, with their items; the first is the default list. */
	shopping?: Record<string, SeedItem[]>;
	/** Open tasks: a title, or a task with a due date and an assignee. */
	tasks?: (string | SeedTask)[];
	/** How far the AI may use an area, for the areas this case changes. */
	areas?: Record<string, AiAreaAccess>;
	checks: Check[];
}

/** The household of most cases: two parents and two children, described only by `about`. */
export const DEFAULT_FAMILY: Person[] = [
	{ name: 'Sofia', roleId: 'admin', about: 'Mother, architect' },
	{ name: 'Lukas', roleId: 'admin', about: 'Father, nurse on shifts' },
	{ name: 'Ellie', roleId: 'supervised', about: '14, swims and plays the piano' },
	{ name: 'Noah', roleId: 'supervised', about: '9, plays football' },
];
export const DEFAULT_TIME_ZONE = 'Europe/Amsterdam';
/** "Today" in every case: Tuesday 6 October 2026, 10:00 in the family time zone. */
export const TODAY = '2026-10-06';
export const NOW = '10:00';

type Member = Awaited<ReturnType<TestKernel['member']>>;

export interface Household {
	/** Ids of the seeded people, events, items and tasks by name or title. */
	seeded: Seeded;
	/** The person who asks. */
	asker: Member;
}

function applied<T>(result: { status: string; output?: unknown }, what: string): T {
	if (result.status !== 'applied') throw new Error(`Seeding failed: ${what} (${result.status})`);
	return result.output as T;
}

/** Sets the family up for a case: settings, clock, people, areas and data. */
export async function seed(k: TestKernel, c: Case): Promise<Household> {
	const timeZone = c.timeZone ?? DEFAULT_TIME_ZONE;
	const system = systemActor('eval');
	applied(
		await k.runner.invoke(
			'core.updateFamilySettings',
			{ timeZone, locale: c.locale ?? 'en' },
			system,
		),
		'family settings',
	);
	k.clock.set(epochOf(TODAY, NOW, timeZone));
	const seeded: Seeded = {};
	let asker: Member | undefined;
	for (const person of c.family ?? DEFAULT_FAMILY) {
		const made = await k.member(person.roleId, person.name);
		if (person.about)
			applied(
				await k.runner.invoke(
					'core.updateMember',
					{ memberId: made.member.id, about: person.about },
					system,
				),
				`about ${person.name}`,
			);
		seeded[person.name] = made.member.id;
		if (c.as ? person.name === c.as : !asker) asker = made;
	}
	if (!asker) throw new Error(`Nobody called ${c.as} in the family`);
	for (const [extensionId, access] of Object.entries(c.areas ?? {}))
		applied(
			await k.runner.invoke(
				'core.setAiAreaAccess',
				{ extensionId, access, confirmSensitive: true },
				system,
			),
			`AI access to ${extensionId}`,
		);
	for (const { who, ...event } of c.events ?? []) {
		const memberIds = (who ?? []).map((name) => {
			const id = seeded[name];
			if (!id) throw new Error(`Nobody called ${name} in the family`);
			return id;
		});
		const made = applied<{ id: string }>(
			await k.runner.invoke('calendar.createEvent', { ...event, memberIds }, system),
			`event ${event.title}`,
		);
		seeded[event.title] = made.id;
	}
	for (const [name, items] of Object.entries(c.shopping ?? {})) {
		const list = applied<{ id: string }>(
			await k.runner.invoke('lists.createShoppingList', { name }, system),
			`list ${name}`,
		);
		seeded[name] = list.id;
		for (const item of items) {
			const added = applied<{ items: { id: string }[] }>(
				await k.runner.invoke(
					'lists.addShoppingItems',
					{
						listId: list.id,
						items: [{ title: item.title, ...(item.quantity && { quantity: item.quantity }) }],
					},
					system,
				),
				`item ${item.title}`,
			);
			const id = added.items[0]?.id;
			if (!id) throw new Error(`Seeding failed: item ${item.title} has no id`);
			seeded[item.title] = id;
			if (item.bought)
				applied(
					await k.runner.invoke('lists.checkShoppingItem', { id, done: true }, system),
					`tick ${item.title}`,
				);
		}
	}
	for (const task of c.tasks ?? []) {
		const { title, dueDate, who } = typeof task === 'string' ? { title: task } : task;
		const assigneeId = who === undefined ? undefined : seeded[who];
		if (who !== undefined && !assigneeId) throw new Error(`Nobody called ${who} in the family`);
		const made = applied<{ id: string }>(
			await k.runner.invoke(
				'lists.addTask',
				{ title, ...(dueDate && { dueDate }), ...(assigneeId && { assigneeId }) },
				system,
			),
			`task ${title}`,
		);
		seeded[title] = made.id;
	}
	return { seeded, asker };
}
