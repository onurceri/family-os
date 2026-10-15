import inbox from '@famos/ext-inbox/server';
import records from '@famos/ext-records/server';
import { systemActor } from '@famos/sdk';
import { createTestKernel, repoTranslate, type TestKernel } from '@famos/testing';
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
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
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

describe('home records in the prompt and in proposals', () => {
	it('lists homes and things by handle, never an id, a serial or an address', async () => {
		k.llm.respond({ summary: 'x', proposals: [] });
		await share('Hello');
		const system = k.llm.calls[0]?.system ?? '';
		expect(system).toContain('- Our flat (home:1): rented');
		expect(system).toContain(
			'- Washing machine (home_item:1): Bosch WAX32, in Our flat, warranty until 2027-09-20',
		);
		expect(system).toContain('Warranty ends (Washing machine) (obligation:1): due 2027-09-20');
		expect(JSON.stringify(k.llm.calls)).not.toMatch(
			/home_[0-9a-f]{8}-|home_item_[0-9a-f]{8}-|SN-SECRET|Moda Cd/,
		);
	});

	it('turns a receipt into an addItem draft with the warranty date that, approved, creates the duty', async () => {
		k.llm.respond({
			summary: 'Fridge receipt',
			proposals: [
				{
					action: 'home.addItem',
					input: {
						homeId: 'home:1',
						homeName: 'Our flat',
						name: 'Fridge',
						brand: 'Samsung',
						model: 'RB38',
						purchasedOn: '2026-10-05',
						warrantyUntil: '2028-10-05',
					},
					dateText: '05.10.2026',
					confidence: 0.9,
				},
			],
		});
		await share('Samsung RB38 buzdolabı, fatura tarihi 05.10.2026, 2 yıl garanti');
		const [draft] = await drafts();
		expect(draft?.actionId).toBe('home.addItem');
		expect(draft?.input).toMatchObject({ homeId: flat.id, warrantyUntil: '2028-10-05' });

		await k.runner.approveDraft(draft?.id ?? '', admin.actor);
		const [fridge] = (await k.route('home.listItems').call({ query: {} })).filter(
			(i: { name: string }) => i.name === 'Fridge',
		);
		expect(fridge).toMatchObject({ homeId: flat.id, warrantyUntil: '2028-10-05' });
		expect(await open(fridge.id)).toMatchObject([
			{ title: 'Warranty ends', dueDate: '2028-10-05', recordKind: 'home_item' },
		]);
	});

	it('turns "warranty extended" into an updateItem draft that moves the warranty duty', async () => {
		k.llm.respond({
			summary: 'Extended warranty',
			proposals: [
				{
					action: 'home.updateItem',
					input: { id: 'home_item:1', itemName: 'Washing machine', warrantyUntil: '2029-09-20' },
					dateText: '20.09.2029',
					confidence: 0.85,
				},
			],
		});
		await share('Uzatılmış garanti belgesi: 20.09.2029 tarihine kadar');
		const [draft] = await drafts();
		expect(draft?.input).toMatchObject({ id: washer.id, warrantyUntil: '2029-09-20' });
		await k.runner.approveDraft(draft?.id ?? '', admin.actor);
		expect(await open(washer.id)).toMatchObject([{ dueDate: '2029-09-20' }]);
		// Nothing else about the thing changed.
		expect(await k.route('home.getItem').call({ params: { itemId: washer.id } })).toMatchObject({
			brand: 'Bosch',
			model: 'WAX32',
		});
	});

	it('drops a proposal for a home it never listed', async () => {
		k.llm.respond({
			summary: 'x',
			proposals: [
				{ action: 'home.addItem', input: { homeId: 'home:9', name: 'Oven' }, confidence: 1 },
				{
					action: 'home.addItem',
					input: { homeId: 'home_00000000-0000-7000-8000-000000000042', name: 'Oven' },
					confidence: 1,
				},
			],
		});
		await share('Oven receipt');
		expect(await drafts()).toHaveLength(0);
	});

	it('tells the model nothing while the home area is locked', async () => {
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'home', access: 'off' },
			admin.actor,
		);
		k.llm.respond({ summary: 'x', proposals: [] });
		await share('Hello');
		const system = k.llm.calls[0]?.system ?? '';
		expect(system).not.toMatch(/home\.addItem|home:1|home_item:1|Washing machine|Our flat/);
		expect(k.llm.calls[0]?.areas).not.toContain('home');
	});
});
