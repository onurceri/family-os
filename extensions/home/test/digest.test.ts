import type { Actor, DigestOutput, MemberId } from '@famos/sdk';
import type { TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKernel, type Person, person } from './support.ts';

const SPAN = { from: '2026-10-06', to: '2026-10-12' };
const id = (prefix: string) => `${prefix}_00000000-0000-7000-8000-000000000001`;

let k: TestKernel;
let mara: Person;

beforeEach(async () => {
	k = await createKernel();
	mara = await person(k, 'admin', 'Mara');
});
afterEach(() => k.close());

const ai: () => Actor = () => ({
	kind: 'ai',
	mode: 'conversation',
	source: 'assistant',
	onBehalfOf: mara.id as MemberId,
	roleId: 'admin',
});
const duty = (recordKind: string, title: string) =>
	k.runner.invoke(
		'records.addObligation',
		{
			recordId: id(recordKind),
			recordKind,
			recordName: title,
			title,
			dueDate: '2026-10-08',
			audience: 'home.view',
		},
		mara.actor,
	);

describe('home.digest', () => {
	it('holds the duties of the homes and their things, never of the services', async () => {
		await duty('home', 'Home insurance');
		await duty('home_item', 'Boiler service');
		await duty('home_service', 'Internet contract');
		await duty('vehicle', 'Car inspection');
		const result = await k.runner.invoke<DigestOutput>('home.digest', SPAN, ai());
		if (result.status !== 'applied') throw new Error('expected a read');
		expect(result.output.items.map((i) => i.title).sort()).toEqual([
			'Boiler service',
			'Home insurance',
		]);
	});

	it('gives nothing to an AI whose area is off', async () => {
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'home', access: 'off' },
			mara.actor,
		);
		await expect(k.runner.invoke('home.digest', SPAN, ai())).rejects.toMatchObject({
			code: 'forbidden',
		});
	});
});
