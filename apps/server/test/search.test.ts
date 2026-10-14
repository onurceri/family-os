import { type Actor, type MemberId, systemActor, type UploadedFile } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extensions } from '../src/extensions.ts';

/**
 * Family search over the real extensions: what is indexed when things are created,
 * changed and removed, and what the rebuild of existing data reads. The fake embedding model is
 * a hashed bag of words.
 */
const system = systemActor('test');
const CAR = 'vehicle_00000000-0000-7000-8000-000000000001';
const INBOX_ITEM = 'inbox_item_00000000-0000-7000-8000-000000000001';

let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [...extensions] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: 'Europe/Istanbul' }, system);
	admin = await k.member('admin', 'Ayşe');
});
afterEach(() => k.close());

const enable = async () => {
	k.llm.embedModel = 'fake:embedder';
	await k.reconcileSearch();
	await k.worker.drain();
};
async function run<T>(actionId: string, input: unknown, actor: Actor = admin.actor): Promise<T> {
	const r = await k.runner.invoke<T>(actionId, input, actor);
	if (r.status !== 'applied') throw new Error(`expected ${actionId} to be applied`);
	await k.worker.drain();
	return r.output;
}
type Hit = { id: string; kind: string; title: string; extension: string };
const find = async (query: string, actor: Actor = admin.actor): Promise<Hit[]> => {
	const r = await k.runner.invoke<{ results: Hit[] }>('core.searchFamily', { query }, actor);
	if (r.status !== 'applied') throw new Error('expected a result');
	return r.output.results;
};
const kinds = async (query: string, actor?: Actor) => (await find(query, actor)).map((h) => h.kind);
const embeddedTexts = () => k.llm.embedCalls.flatMap((c) => c.texts).join('\n');
const aiFor = (): Actor => ({
	kind: 'ai',
	mode: 'conversation',
	source: 'assistant',
	onBehalfOf: admin.member.id as MemberId,
	roleId: 'admin',
	local: false,
});

describe('kitchen', () => {
	it('indexes a recipe when it is added, changed and archived', async () => {
		await enable();
		const recipe = await run<{ id: string }>('kitchen.createRecipe', {
			title: 'Lentil soup',
			ingredients: ['1 cup red lentils', '1 onion'],
			steps: ['Simmer everything'],
			tags: ['soup'],
		});
		expect(await find('red lentils soup')).toMatchObject([
			{ id: recipe.id, kind: 'kitchen.recipe', title: 'Lentil soup' },
		]);

		await run('kitchen.updateRecipe', {
			id: recipe.id,
			recipe: {
				title: 'Lentil soup',
				ingredients: ['2 cups yellow split peas'],
				steps: ['Simmer'],
				tags: [],
			},
		});
		expect(await find('red lentils')).toEqual([]);
		expect((await find('split peas')).map((h) => h.id)).toEqual([recipe.id]);

		await run('kitchen.archiveRecipe', { id: recipe.id });
		expect(await find('split peas')).toEqual([]);
	});
});

describe('home', () => {
	it('indexes things and services, never serial or account numbers, and forgets them with the home', async () => {
		await enable();
		const flat = await run<{ id: string }>('home.addHome', {
			name: 'Our flat',
			address: 'Moda Cd. 12',
			tenure: 'owner',
		});
		const boiler = await run<{ id: string }>('home.addItem', {
			homeId: flat.id,
			name: 'Boiler',
			brand: 'Vaillant',
			model: 'ecoTEC',
			room: 'Kitchen',
			serial: 'SERIAL-777',
			notes: 'Serviced every autumn',
		});
		const power = await run<{ id: string }>('home.addService', {
			homeId: flat.id,
			kind: 'electricity',
			provider: 'Enerjisa',
			accountNumber: 'ACCOUNT-4455',
		});
		expect((await find('vaillant boiler')).map((h) => h.id)).toEqual([boiler.id]);
		expect((await find('enerjisa electricity')).map((h) => h.id)).toEqual([power.id]);
		expect(embeddedTexts()).not.toContain('SERIAL-777');
		expect(embeddedTexts()).not.toContain('ACCOUNT-4455');

		await run('home.updateItem', { id: boiler.id, notes: 'Replaced the pump' });
		expect((await find('replaced pump')).map((h) => h.id)).toEqual([boiler.id]);

		await run('home.archiveHome', { id: flat.id });
		expect(await find('vaillant boiler')).toEqual([]);
		expect(await find('enerjisa electricity')).toEqual([]);
	});
});

describe('calendar', () => {
	it('indexes an event by title, place and notes, and forgets a deleted one', async () => {
		await enable();
		const event = await run<{ id: string }>('calendar.createEvent', {
			title: 'Dentist',
			date: '2026-10-20',
			startTime: '14:00',
			location: 'Moda Dental Clinic',
			notes: 'Bring the x-ray',
		});
		expect((await find('dental clinic x-ray')).map((h) => h.id)).toEqual([event.id]);
		await run('calendar.updateEvent', {
			id: event.id,
			event: { title: 'Dentist', date: '2026-10-21', startTime: '14:00', notes: 'Bring cash' },
		});
		expect(await find('x-ray')).toEqual([]);
		expect((await find('bring cash')).map((h) => h.id)).toEqual([event.id]);
		await run('calendar.deleteEvent', { id: event.id });
		expect(await find('bring cash')).toEqual([]);
	});
});

describe('records', () => {
	it('indexes obligations and papers, and forgets them when done or detached', async () => {
		await enable();
		const duty = await run<{ id: string }>('records.addObligation', {
			recordId: CAR,
			recordKind: 'vehicle',
			recordName: 'Family car',
			kind: 'service',
			title: 'Boiler service',
			dueDate: '2026-11-01',
			notes: 'Call the plumber first',
			audience: 'records.view',
		});
		expect((await find('boiler service plumber')).map((h) => h.id)).toEqual([duty.id]);

		const key = `inbox/${INBOX_ITEM}/0`;
		await k.ctx.files.put(key, new TextEncoder().encode('x'), 'application/pdf');
		const [paper] = await run<{ id: string }[]>('records.attachDocument', {
			recordId: CAR,
			recordKind: 'vehicle',
			files: [{ key, name: 'insurance-policy.pdf', type: 'application/pdf' }],
			label: 'policy',
		});
		const found = await find('insurance policy');
		expect(found.map((h) => h.id)).toContain(paper?.id);

		await run('records.detachDocument', { id: paper?.id });
		expect((await find('insurance policy')).map((h) => h.id)).not.toContain(paper?.id);

		await run('records.completeObligation', { id: duty.id });
		expect(await find('boiler service plumber')).toEqual([]);
	});

	it('hides an obligation from the AI when the area of its audience is off', async () => {
		await enable();
		await run('records.addObligation', {
			recordId: CAR,
			recordKind: 'vehicle',
			recordName: 'Pantry',
			kind: 'check',
			title: 'Check the pantry stock',
			dueDate: '2026-11-01',
			audience: 'kitchen.view',
		});
		expect(await kinds('pantry stock', aiFor())).toEqual(['records.obligation']);
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'kitchen', access: 'off' },
			system,
		);
		await k.worker.drain();
		expect(await kinds('pantry stock', aiFor())).toEqual([]);
		// Vectors of a closed area are not used for anyone.
		expect(await kinds('pantry stock')).toEqual([]);
	});
});

describe('inbox', () => {
	const share = async (body: Record<string, unknown>, files: UploadedFile[] = []) =>
		(await k.route('inbox.createItem').call({
			body: { channel: 'share', ...body },
			files,
			actor: admin.actor,
		})) as { id: string; status: string };

	it('indexes what was shared for the person who shared it, and forgets a dismissed item', async () => {
		await enable();
		const other = await k.member('supervised', 'Elif');
		k.llm.respond({ summary: 'The school asks for a signed trip permission slip', proposals: [] });
		const item = await share({ text: 'Please sign the zoo permission slip' });
		await k.worker.drain();
		expect((await find('zoo permission slip')).map((h) => h.id)).toEqual([item.id]);
		expect(await kinds('zoo permission slip', other.actor)).toEqual([]);
		expect(await kinds('zoo permission slip', aiFor())).toEqual(['inbox.item']);

		await run('inbox.dismissItem', { id: item.id });
		expect(await find('zoo permission slip')).toEqual([]);
	});

	it('does not index an item that was filed on a record by hand', async () => {
		await enable();
		const bytes = new TextEncoder().encode('POLICY 123 passport copy');
		const filed = await share(
			{
				text: 'Passport copy for the visa',
				fileToRecordId: CAR,
				fileToRecordKind: 'vehicle',
				fileToRecordName: 'Golf',
			},
			[
				{
					field: 'files',
					name: 'policy.pdf',
					type: 'application/pdf',
					size: bytes.length,
					bytes: async () => bytes,
					async *stream() {
						yield bytes;
					},
				},
			],
		);
		await k.worker.drain();
		expect(filed.status).toBe('filed');
		expect((await find('passport copy visa')).map((h) => h.kind)).not.toContain('inbox.item');
	});
});

describe('rebuild', () => {
	it('reads everything that existed before an embedding model was set', async () => {
		const recipe = await run<{ id: string }>('kitchen.createRecipe', {
			title: 'Pasta',
			ingredients: ['500 g spaghetti'],
			steps: ['Boil'],
		});
		const event = await run<{ id: string }>('calendar.createEvent', {
			title: 'Piano lesson',
			date: '2026-10-20',
			startTime: '16:00',
		});
		const duty = await run<{ id: string }>('records.addObligation', {
			recordId: CAR,
			recordKind: 'vehicle',
			recordName: 'Family car',
			kind: 'inspection',
			title: 'Vehicle inspection',
			dueDate: '2027-01-01',
			audience: 'records.view',
		});
		expect(k.llm.embedCalls).toHaveLength(0);

		await enable();
		expect((await find('spaghetti')).map((h) => h.id)).toEqual([recipe.id]);
		expect((await find('piano lesson')).map((h) => h.id)).toEqual([event.id]);
		expect((await find('vehicle inspection')).map((h) => h.id)).toEqual([duty.id]);
	});
});
