import inbox from '@famos/ext-inbox/server';
import records from '@famos/ext-records/server';
import { systemActor } from '@famos/sdk';
import {
	createTestKernel,
	mention,
	repoTranslate,
	type TestKernel,
	understood,
} from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import home from '../src/server/index.ts';

const TZ = 'Europe/Istanbul';
let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
let flat: { id: string };
let washer: { id: string };

beforeEach(async () => {
	k = await createTestKernel({ extensions: [records, home, inbox], translate: repoTranslate() });
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ timeZone: TZ, formatLocale: 'tr-TR' },
		systemActor('test'),
	);
	k.clock.set(epochOf('2026-10-06', '10:00', TZ));
	admin = await k.member('admin', 'Ayşe');
	const add = async <T>(actionId: string, input: Record<string, unknown>) => {
		const r = await k.runner.invoke<T>(actionId, input, admin.actor);
		if (r.status !== 'applied') throw new Error('expected applied');
		return r.output;
	};
	flat = await add('home.addHome', { name: 'Our flat', address: 'Moda Cd. 12', tenure: 'tenant' });
	washer = await add('home.addItem', {
		homeId: flat.id,
		name: 'Washing machine',
		brand: 'Bosch',
		model: 'WAX32',
		serial: 'SN-SECRET-1',
		warrantyUntil: '2027-09-20',
	});
});
afterEach(() => k.close());

const share = async (text: string) => {
	await k.route('inbox.createItem').call({
		body: { channel: 'share', text },
		files: [],
		actor: admin.actor,
	});
	await k.worker.drain();
};
const drafts = (): Promise<{ id: string; actionId: string; input: Record<string, unknown> }[]> =>
	k.route('core.listDrafts').call({
		query: { sourceKind: 'inbox', limit: 50 },
		actor: admin.actor,
	});
const open = (recordId: string) =>
	k.route('records.listObligations').call({ query: { recordId, status: 'open' } });

describe('home records in the prompt and in mentions', () => {
	it('lists homes and things by name, never an id, a handle, a serial or an address', async () => {
		k.llm.respond(understood());
		await share('Hello');
		const system = k.llm.calls[0]?.system ?? '';
		expect(system).toContain('- Our flat (rented)');
		expect(system).toContain(
			'- Washing machine (Bosch WAX32, in Our flat, warranty until 2027-09-20)',
		);
		expect(system).toContain('- Warranty ends (Washing machine) (due 2027-09-20');
		expect(JSON.stringify(k.llm.calls)).not.toMatch(
			/home_[0-9a-f]{8}-|home_item_[0-9a-f]{8}-|home:1|SN-SECRET|Moda Cd/,
		);
	});

	it('turns a receipt into an addItem draft with the warranty date that, approved, creates the duty', async () => {
		k.llm.respond(
			understood([
				mention('home.item', {
					title: 'Buzdolabı',
					lines: ['Samsung', 'RB38'],
					date: { text: '05.10.2026', numeric: '05.10.2026' },
					amount: '24',
				}),
			]),
		);
		await share('Samsung RB38 buzdolabı, fatura tarihi 05.10.2026, 2 yıl garanti');
		const [draft] = await drafts();
		expect(draft?.actionId).toBe('home.addItem');
		expect(draft?.input).toMatchObject({ homeId: flat.id, warrantyUntil: '2028-10-05' });

		await k.runner.approveDraft(draft?.id ?? '', admin.actor);
		const [fridge] = (await k.route('home.listItems').call({ query: {} })).filter(
			(i: { name: string }) => i.name === 'Buzdolabı',
		);
		expect(fridge).toMatchObject({ homeId: flat.id, warrantyUntil: '2028-10-05' });
		expect(await open(fridge.id)).toMatchObject([
			{ title: 'Warranty ends', dueDate: '2028-10-05', recordKind: 'home_item' },
		]);
	});

	it('turns "warranty extended" into an updateItem draft that moves the warranty duty', async () => {
		k.llm.respond(
			understood([
				mention('home.item', {
					target: 'çamaşır makinesi',
					endDate: { text: '20.09.2029', numeric: '20.09.2029' },
				}),
			]),
		);
		await share('Washing machine: uzatılmış garanti belgesi, 20.09.2029 tarihine kadar');
		const [draft] = await drafts();
		expect(draft).toBeUndefined();

		k.llm.respond(
			understood([
				mention('home.item', {
					target: 'Washing machine',
					endDate: { text: '20.09.2029', numeric: '20.09.2029' },
				}),
			]),
		);
		await share('Washing machine: uzatılmış garanti belgesi, 20.09.2029 tarihine kadar');
		const [update] = await drafts();
		expect(update?.input).toMatchObject({ id: washer.id, warrantyUntil: '2029-09-20' });
		await k.runner.approveDraft(update?.id ?? '', admin.actor);
		expect(await open(washer.id)).toMatchObject([{ dueDate: '2029-09-20' }]);
		// Nothing else about the thing changed.
		expect(await k.route('home.getItem').call({ params: { itemId: washer.id } })).toMatchObject({
			brand: 'Bosch',
			model: 'WAX32',
		});
	});

	it('leaves out a thing for a home the household does not have', async () => {
		k.llm.respond(understood([mention('home.item', { title: 'Oven', about: 'the beach house' })]));
		await share('Oven receipt for the beach house');
		expect(await drafts()).toHaveLength(0);
	});

	it('tells the model nothing while the home area is locked', async () => {
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'home', access: 'off' },
			admin.actor,
		);
		k.llm.respond(understood());
		await share('Hello');
		const system = k.llm.calls[0]?.system ?? '';
		expect(system).not.toMatch(/home\.item|- Washing machine|- Our flat/);
		expect(k.llm.calls[0]?.areas).not.toContain('home');
	});
});
