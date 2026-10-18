import type { Actor, DigestOutput, MemberId } from '@famos/sdk';
import type { TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKernel, type Person, person } from './support.ts';

// The clock stands at Tuesday 6 October 2026.
const CAR = 'vehicle_00000000-0000-7000-8000-000000000001';
const SPAN = { from: '2026-10-06', to: '2026-10-12' };

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
const duty = (input: Record<string, unknown>) =>
	k.runner.invoke('records.addObligation', { recordName: 'Family car', ...input }, mara.actor);

describe('vehicles.digest', () => {
	it('holds only the vehicles’ duties in the span, and what comes next when empty', async () => {
		await duty({
			recordId: CAR,
			recordKind: 'vehicle',
			title: 'Inspection',
			dueDate: '2026-10-08',
		});
		await duty({
			recordId: 'pet_00000000-0000-7000-8000-000000000001',
			recordKind: 'pet',
			title: 'Vaccination',
			dueDate: '2026-10-08',
		});
		await duty({ recordId: CAR, recordKind: 'vehicle', title: 'Tax', dueDate: '2027-01-31' });
		const result = await k.runner.invoke<DigestOutput>('vehicles.digest', SPAN, ai());
		if (result.status !== 'applied') throw new Error('expected a read');
		expect(result.output.items.map((i) => i.title)).toEqual(['Inspection']);
		const empty = await k.runner.invoke<DigestOutput>(
			'vehicles.digest',
			{ from: '2026-10-10', to: '2026-10-12' },
			ai(),
		);
		if (empty.status !== 'applied') throw new Error('expected a read');
		expect(empty.output.nextAfter).toMatchObject({ title: 'Tax', date: '2027-01-31' });
	});

	it('gives nothing to an AI whose area is off', async () => {
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'vehicles', access: 'off' },
			mara.actor,
		);
		await expect(k.runner.invoke('vehicles.digest', SPAN, ai())).rejects.toMatchObject({
			code: 'forbidden',
		});
	});
});
