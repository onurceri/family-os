import { type DraftPresenter, draftDate, removalPresenter } from '@famos/ui/slots';
import { Car, Wrench } from '@lucide/svelte';
import type { AddLogInput, AddVehicleInput } from '../contract/index.js';

/** How a suggested vehicle reads in the Inbox. */
export const addVehiclePresenter: DraftPresenter<AddVehicleInput> = {
	actionId: 'vehicles.addVehicle',
	kind: (c) => c.t('vehicles:kind_vehicle'),
	icon: Car,
	title: (input) => input.name,
	fields: (input, c) => [
		...(input.plate
			? [{ label: c.t('vehicles:draft_plate'), value: input.plate, path: 'plate' }]
			: []),
	],
	approveLabel: (c) => c.t('vehicles:draft_approve_add'),
};

/** A service or repair, as the AI reads it from an invoice or a person suggests it. */
export const addLogPresenter: DraftPresenter<AddLogInput & { label?: string }> = {
	actionId: 'vehicles.addLog',
	kind: (c) => c.t('vehicles:kind_log'),
	icon: Wrench,
	title: (input, c) => {
		const vehicle = input.label || input.vehicleName;
		const kind = c.t(`vehicles:log_kind_${input.kind ?? 'service'}`);
		return vehicle ? `${vehicle} · ${kind}` : kind;
	},
	fields: (input, c) => [
		{ label: c.t('vehicles:draft_date'), value: draftDate(input.doneOn, c), path: 'doneOn' },
		...(input.place
			? [{ label: c.t('vehicles:draft_place'), value: input.place, path: 'place' }]
			: []),
		...(input.notes
			? [{ label: c.t('vehicles:draft_notes'), value: input.notes, path: 'notes' }]
			: []),
	],
	approveLabel: (c) => c.t('vehicles:draft_approve_log'),
};

/** A suggestion to remove a service or repair entry: its row's mark says it would be removed. */
export const removeLogPresenter = removalPresenter({
	actionId: 'vehicles.removeLog',
	kindKey: 'vehicles:kind_log',
	titleKey: 'vehicles:draft_title_remove_log',
	icon: Wrench,
});

/** A suggestion to archive a vehicle: its page says it would be removed. */
export const archiveVehiclePresenter = removalPresenter({
	actionId: 'vehicles.archiveVehicle',
	kindKey: 'vehicles:kind_vehicle',
	titleKey: 'vehicles:draft_title_archive_vehicle',
	icon: Car,
});
