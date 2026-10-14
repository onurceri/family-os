import { defineAction, defineCapability } from '@famos/sdk';
import type { TestKernel } from '@famos/testing';
import { defineTestExtension } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type Obligation, type ObligationPreset, RecordIdSchema } from '../src/contract/index.ts';
import { applied, CAR, createKernel, type Person, person } from './support.ts';

/** A stand-in domain extension: it owns "cars", and talks to records only by action id. */
const garageEdit = defineCapability({ id: 'garage.edit', label: 'garage:cap_edit', level: 'edit' });
const archiveCar = defineAction({
	id: 'garage.archiveCar',
	title: 'Archive a car',
	input: z.object({ recordId: RecordIdSchema }),
	output: z.object({ archived: z.number() }),
	requires: garageEdit.id,
	approval: 'never',
	async run(uow, { recordId }) {
		const r = await uow.run<unknown, { obligations: number }>('records.archiveForRecord', {
			recordId,
		});
		return { archived: r.obligations };
	},
});
const garage = defineTestExtension({
	id: 'garage',
	dependsOn: ['records'],
	calls: ['records.archiveForRecord'],
	actions: [archiveCar],
	capabilities: [garageEdit],
});

/** What a domain exports for the "what usually needs doing" list. */
const presets: ObligationPreset[] = [
	{ id: 'inspection', titleKey: 'garage:preset_inspection', every: { years: 2 }, leadDays: 30 },
	{ id: 'warranty_end', titleKey: 'garage:preset_warranty_end' },
];

let k: TestKernel;
let admin: Person;

beforeEach(async () => {
	({ k } = await createKernel({ extensions: [garage] }));
	admin = await person(k, 'admin');
});
afterEach(() => k.close());

describe('a domain extension using records', () => {
	it('archives a record’s obligations through its own archive action', async () => {
		const preset = presets[0] as ObligationPreset;
		await applied<Obligation>(
			k,
			'records.addObligation',
			{
				recordId: CAR,
				recordKind: 'vehicle',
				recordName: 'Golf',
				kind: preset.id,
				title: 'Inspection',
				dueDate: '2026-12-01',
				every: preset.every,
				leadDays: preset.leadDays,
			},
			admin.actor,
		);
		const out = await applied<{ archived: number }>(
			k,
			'garage.archiveCar',
			{ recordId: CAR },
			admin.actor,
		);
		expect(out.archived).toBe(1);
		const open = await k
			.route('records.listObligations')
			.call({ query: { recordId: CAR, status: 'open' } });
		expect(open).toHaveLength(0);
	});

	it('lets a member with the domain capability archive without records.edit being asked', async () => {
		// A custom role: may edit cars but not records. The domain action is the permission.
		const role = await k.runner.invoke<{ id: string }>(
			'core.createRole',
			{
				name: 'Car person',
				base: 'supervised',
				overrides: { 'garage.edit': true, 'records.edit': false },
			},
			admin.actor,
		);
		if (role.status !== 'applied') throw new Error('expected role');
		const driver = await person(k, role.output.id, 'Driver');
		const out = await applied<{ archived: number }>(
			k,
			'garage.archiveCar',
			{ recordId: CAR },
			driver.actor,
		);
		expect(out.archived).toBe(0);
	});
});
