import { defineAction, defineCapability } from '@famos/sdk';
import type { TestKernel } from '@famos/testing';
import { defineTestExtension } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type Obligation, type ObligationPreset, RecordIdSchema } from '../src/contract/index.ts';
import { applied, CAR, createKernel, type Person, person, recordId } from './support.ts';

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
// The same, but a person who lacks `garage.edit` may suggest it.
const archiveCarAsked = defineAction({
	id: 'garage.archiveCarAsked',
	title: 'Archive a car, or suggest it',
	draftTitle: 'garage:draft_archive',
	input: z.object({ recordId: RecordIdSchema }),
	output: z.object({ archived: z.number() }),
	approval: { unless: garageEdit.id },
	async run(uow, { recordId }) {
		const r = await uow.run<unknown, { obligations: number }>('records.archiveForRecord', {
			recordId,
		});
		return { archived: r.obligations };
	},
});
// Archives a record of another extension (a pet), which the garage does not own.
const archivePet = defineAction({
	id: 'garage.archivePet',
	title: 'Archive a pet',
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
	recordIds: ['vehicle'],
	actions: [archiveCar, archiveCarAsked, archivePet],
	capabilities: [garageEdit],
});
// Uses records for things it does not own.
const shed = defineTestExtension({
	id: 'shed',
	dependsOn: ['records'],
	calls: ['records.archiveForRecord'],
	actions: [
		defineAction({
			id: 'shed.archiveCar',
			title: 'Archive a car from the shed',
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
		}),
	],
});

/** What a domain exports for the "what usually needs doing" list. */
const presets: ObligationPreset[] = [
	{ id: 'inspection', titleKey: 'garage:preset_inspection', every: { years: 2 }, leadDays: 30 },
	{ id: 'warranty_end', titleKey: 'garage:preset_warranty_end' },
];

let k: TestKernel;
let admin: Person;

beforeEach(async () => {
	({ k } = await createKernel({ extensions: [garage, shed] }));
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

	describe('a record only its owner speaks for', () => {
		const driverRole = async () => {
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
			return person(k, role.output.id, 'Driver');
		};

		it('refuses another extension that is not the record’s owner', async () => {
			const driver = await driverRole();
			await expect(
				k.runner.invoke('shed.archiveCar', { recordId: CAR }, driver.actor),
			).rejects.toMatchObject({
				code: 'forbidden',
				details: { reason: 'nested_needs_approval', capability: 'records.edit' },
			});
		});

		it('refuses the owner on a record of another kind', async () => {
			const driver = await driverRole();
			await expect(
				k.runner.invoke('garage.archivePet', { recordId: recordId('pet') }, driver.actor),
			).rejects.toMatchObject({
				code: 'forbidden',
				details: { reason: 'nested_needs_approval' },
			});
		});

		it('still turns a supervised member’s domain action into a suggestion', async () => {
			const kid = await person(k, 'supervised', 'Elif');
			const result = await k.runner.invoke('garage.archiveCarAsked', { recordId: CAR }, kid.actor);
			expect(result.status).toBe('drafted');
			if (result.status !== 'drafted') return;
			const approved = await k.runner.approveDraft(result.draftId, admin.actor);
			expect(approved.status).toBe('applied');
		});
	});
});
