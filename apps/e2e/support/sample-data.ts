import type { Page } from '@playwright/test';
import { answer, mention, on } from './drafts.ts';
import type { FakeModel } from './fake-model.ts';
import { api, FAMILY_TIME_ZONE, nextWeek, shareText } from './fixtures.ts';
import { createMember } from './members.ts';

const day = (offset: number) =>
	new Intl.DateTimeFormat('en-CA', { timeZone: FAMILY_TIME_ZONE }).format(
		new Date(Date.now() + offset * 86_400_000),
	);

/** The ids of the records that have a page of their own. */
export type SampleData = {
	home: string;
	vehicle: string;
	pet: string;
	recipe: string;
	/** The assistant conversation that planned the soup (one of two). */
	thread: string;
};

/**
 * A family with something in every area (members, a shared text read into drafts, events, lists,
 * a chore, a home, a vehicle, a pet, a recipe, board notes): what the design sweep opens
 * every page with. Call it on a signed-in admin page.
 */
export async function seedSampleFamily(page: Page, model: FakeModel): Promise<SampleData> {
	// Full names, four people: the family columns on Today must fit them without cutting a name,
	// and greetings must use the first name ("Good morning, Deniz.").
	const me = await api<{ id: string }>(page, 'GET', '/api/v1/core/me');
	await api(page, 'POST', '/api/v1/actions/core.updateMember', {
		memberId: me.id,
		displayName: 'Deniz Brandt',
	});
	const amy = await createMember(page, { name: 'Amy Lindqvist', role: 'member' });
	const elif = await createMember(page, {
		name: 'Elif Brandt-Okafor',
		role: 'supervised',
		pin: '4826',
	});
	const noah = await createMember(page, { name: 'Noah Brandt', role: 'supervised' });

	model.answer(
		answer(
			'Class newsletter',
			mention('calendar.event', {
				title: 'Parent meeting',
				date: on(nextWeek()),
				time: '17:00',
				unsure: ['time'],
				quote: 'Parent meetings next week from 17:00',
			}),
			mention('lists.task', {
				title: 'Sign the trip form',
				date: on(day(2)),
				quote: 'Please sign the trip form by Friday',
			}),
		),
	);
	await shareText(
		page,
		'Parent meetings next week from 17:00. Please sign the trip form by Friday.',
	);
	// Today's hero must keep its title whole in every countdown: the sweep stands at 15:20 (Piano
	// lesson in 40 minutes) and at 09:14 (Family brunch in 1 hour 46). A long title with a long
	// place must stay inside its person's column.
	for (const [title, startTime, memberIds, location] of [
		['Family brunch', '11:00', [], undefined],
		['Dentist', '13:30', [amy], undefined],
		['Swimming', '17:30', [elif], undefined],
		['Piano lesson', '16:00', [noah], undefined],
		['Study group with the robotics club', '18:00', [elif], 'Central Library, reading room 3'],
		['Dinner at grandma', '19:30', [], undefined],
	] as const)
		await api(page, 'POST', '/api/v1/actions/calendar.createEvent', {
			title,
			date: day(0),
			startTime,
			memberIds,
			...(location && { location }),
		});
	// Short events on the hour grid: 15, 30 and 45 minutes, and two 30-minute events side by side.
	// All end before 09:14, so Today's next thing stays the same at both times the sweep stands at.
	for (const [title, startTime, endTime, memberIds, location] of [
		['Walk the dog', '07:00', '07:15', [noah], undefined],
		['Physio session', '07:30', '08:00', [me.id], 'Physio practice'],
		['Maths tutoring', '07:30', '08:00', [elif], 'Online'],
		['Parent-teacher meeting', '08:15', '09:00', [amy, me.id], 'School, room 12'],
	] as const)
		await api(page, 'POST', '/api/v1/actions/calendar.createEvent', {
			title,
			date: day(0),
			startTime,
			endTime,
			memberIds,
			...(location && { location }),
		});
	await api(page, 'POST', '/api/v1/actions/calendar.createEvent', {
		title: 'Football',
		date: day(2),
		startTime: '10:00',
	});
	// A removal waiting for approval: its card says which date goes.
	model.answer(
		answer(
			'Football off',
			mention('calendar.eventCancel', {
				target: 'Football',
				date: on(day(2)),
				quote: `Football on ${day(2)} is off`,
			}),
		),
	);
	await shareText(page, `Football on ${day(2)} is off, the pitch is closed.`);
	// Shopping: two lists; eight things on the first, three of them already in the cart.
	type Added = { output: { items: { id: string; title: string }[] } };
	const groceries = await api<Added>(page, 'POST', '/api/v1/actions/lists.addShoppingItems', {
		items: [
			{ title: 'Tomatoes', quantity: '2 kg' },
			{ title: 'Bread' },
			{ title: 'Milk', quantity: '2' },
			{ title: 'Eggs', quantity: '10' },
			{ title: 'Apples', quantity: '1 kg' },
			{ title: 'Coffee' },
			{ title: 'Dish soap' },
			{ title: 'Yogurt', quantity: '4' },
		],
	});
	for (const item of groceries.output.items.filter((i) =>
		['Coffee', 'Eggs', 'Dish soap'].includes(i.title),
	))
		await api(page, 'POST', '/api/v1/actions/lists.checkShoppingItem', { id: item.id, done: true });
	const pharmacy = await api<{ output: { id: string } }>(
		page,
		'POST',
		'/api/v1/actions/lists.createShoppingList',
		{ name: 'Pharmacy' },
	);
	await api(page, 'POST', '/api/v1/actions/lists.addShoppingItems', {
		listId: pharmacy.output.id,
		items: [{ title: 'Plasters' }, { title: 'Sun cream', quantity: '1' }],
	});
	// Tasks: one late, two today, one this week, one later, one without a date, two done.
	type AddedTask = { output: { id: string; dueDate: string | null } };
	for (const task of [
		{ title: 'Return library books', dueDate: day(-1), assigneeId: amy },
		{ title: 'Book the cat check-up', dueDate: day(0), dueTime: '17:00' },
		{ title: 'Pack the swimming bag', dueDate: day(0), assigneeId: elif },
		{ title: 'Pay the school trip', dueDate: day(3), assigneeId: amy },
		{ title: 'Renew the passports', dueDate: day(20) },
		{ title: 'Fix the bike light', assigneeId: elif },
	])
		await api(page, 'POST', '/api/v1/actions/lists.addTask', task);
	for (const title of ['Water the plants', 'Call the plumber']) {
		const added = await api<AddedTask>(page, 'POST', '/api/v1/actions/lists.addTask', {
			title,
			dueDate: day(-1),
			assigneeId: amy,
		});
		await api(page, 'POST', '/api/v1/actions/lists.completeTask', {
			id: added.output.id,
			dueDate: added.output.dueDate,
		});
	}
	await api(page, 'POST', '/api/v1/actions/chores.createChore', {
		title: 'Empty the dishwasher',
		startDate: day(0),
		assigneeIds: [],
		rotation: 'round_robin',
	});
	type Created = { output: { id: string } };
	const flat = await api<Created>(page, 'POST', '/api/v1/actions/home.addHome', {
		name: 'Our flat',
	});
	const clio = await api<Created>(page, 'POST', '/api/v1/actions/vehicles.addVehicle', {
		name: 'Clio',
		plate: '34 ABC 123',
		fuel: 'petrol',
	});
	const pamuk = await api<Created>(page, 'POST', '/api/v1/actions/pets.addPet', {
		name: 'Pamuk',
		species: 'cat',
	});
	const soup = await api<Created>(page, 'POST', '/api/v1/actions/kitchen.createRecipe', {
		title: 'Lentil soup',
		servings: '4',
		ingredients: ['1 cup red lentils', '1 onion'],
		steps: ['Simmer everything for 30 minutes.'],
	});
	// The assistant plans the soup for tomorrow: a meal draft that names a saved recipe.
	model.chat(
		{ tool: 'kitchen_listRecipes', input: {} },
		{
			tool: 'kitchen_addToMealPlan',
			input: { date: day(1), slot: 'dinner', recipeId: 'recipe:1' },
		},
		{ text: 'Lentil soup is ready to go on the plan for tomorrow.' },
	);
	const soupChat = await api<{ output: { threadId: string } }>(
		page,
		'POST',
		'/api/v1/actions/assistant.sendMessage',
		{ text: 'Plan the lentil soup for dinner tomorrow' },
	);
	await answered(page, soupChat.output.threadId);
	// A second, shorter conversation, so the history has more than one.
	model.chat({ text: 'Noah has swimming on Tuesday and Thursday at 17:00.' });
	const swimChat = await api<{ output: { threadId: string } }>(
		page,
		'POST',
		'/api/v1/actions/assistant.sendMessage',
		{ text: 'When is Noah swimming this week?' },
	);
	await answered(page, swimChat.output.threadId);
	for (const note of [
		{ text: 'Wi-Fi password is on the fridge', paper: 'note-1', pinned: true },
		{ text: 'Dinner at grandma’s on Sunday, bring the cake', paper: 'note-2', endsOn: day(3) },
		{ text: 'The plumber comes Friday morning.\nSomeone needs to be home.', paper: 'note-4' },
		{ text: 'Bins out tonight', paper: 'note-5', endsOn: day(0) },
	])
		await api(page, 'POST', '/api/v1/actions/board.postNote', note);
	return {
		home: flat.output.id,
		vehicle: clio.output.id,
		pet: pamuk.output.id,
		recipe: soup.output.id,
		thread: soupChat.output.threadId,
	};
}

/** Waits until the assistant has finished answering in a conversation. */
async function answered(page: Page, threadId: string) {
	for (let i = 0; i < 100; i++) {
		const detail = await api<{ messages: { status: string }[] }>(
			page,
			'GET',
			`/api/v1/assistant/threads/${threadId}`,
		);
		if (!detail.messages.some((m) => m.status === 'pending' || m.status === 'streaming')) return;
		await page.waitForTimeout(100);
	}
	throw new Error(`The assistant did not answer in ${threadId}`);
}
