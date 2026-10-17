import {
	freshPick,
	type ObligationPreset,
	type PresetPickState,
	scheduleOfPick,
} from '@famos/ext-records/contract';
import { FIELD_REASON, type FieldErrors } from '@famos/ui/forms';
import type {
	Home,
	HomeFields,
	Item,
	ItemFields,
	Service,
	ServiceFields,
	ServiceKind,
	Tenure,
} from '../contract/index.js';

/** The forms as the inputs hold them (strings); converted to the contract's fields on save. */
export interface HomeFormValue {
	name: string;
	address: string;
	tenure: Tenure;
	notes: string;
}
export const emptyHome = (): HomeFormValue => ({
	name: '',
	address: '',
	tenure: 'owner',
	notes: '',
});
export const fromHome = (h: Home): HomeFormValue => ({
	name: h.name,
	address: h.address,
	tenure: h.tenure,
	notes: h.notes ?? '',
});
export const toHomeFields = (v: HomeFormValue): HomeFields => ({
	name: v.name.trim(),
	address: v.address.trim(),
	tenure: v.tenure,
	notes: v.notes.trim() || null,
});
export const validateHome = (v: HomeFormValue): FieldErrors =>
	v.name.trim() ? {} : { name: FIELD_REASON.name };

export interface ItemFormValue {
	name: string;
	room: string;
	brand: string;
	model: string;
	serial: string;
	purchasedOn: string;
	warrantyUntil: string;
	notes: string;
}
export const emptyItem = (): ItemFormValue => ({
	name: '',
	room: '',
	brand: '',
	model: '',
	serial: '',
	purchasedOn: '',
	warrantyUntil: '',
	notes: '',
});
export const fromItem = (i: Item): ItemFormValue => ({
	name: i.name,
	room: i.room,
	brand: i.brand,
	model: i.model,
	serial: i.serial ?? '',
	purchasedOn: i.purchasedOn ?? '',
	warrantyUntil: i.warrantyUntil ?? '',
	notes: i.notes ?? '',
});
export const toItemFields = (v: ItemFormValue): ItemFields => ({
	name: v.name.trim(),
	room: v.room.trim(),
	brand: v.brand.trim(),
	model: v.model.trim(),
	serial: v.serial.trim() || null,
	purchasedOn: v.purchasedOn || null,
	warrantyUntil: v.warrantyUntil || null,
	notes: v.notes.trim() || null,
});
export const validateItem = (v: ItemFormValue): FieldErrors => {
	const errors: FieldErrors = {};
	if (!v.name.trim()) errors.name = FIELD_REASON.name;
	if (v.purchasedOn && v.warrantyUntil && v.warrantyUntil < v.purchasedOn)
		errors.warrantyUntil = 'home:error_warranty_before_purchase';
	return errors;
};

export interface ServiceFormValue {
	kind: ServiceKind;
	provider: string;
	accountNumber: string;
	dueDay: string;
	notes: string;
}
export const emptyService = (): ServiceFormValue => ({
	kind: 'electricity',
	provider: '',
	accountNumber: '',
	dueDay: '',
	notes: '',
});
export const fromService = (s: Service): ServiceFormValue => ({
	kind: s.kind,
	provider: s.provider,
	accountNumber: s.accountNumber ?? '',
	dueDay: s.dueDay === null ? '' : String(s.dueDay),
	notes: s.notes ?? '',
});
export const toServiceFields = (v: ServiceFormValue): ServiceFields => {
	const day = Number.parseInt(v.dueDay, 10);
	return {
		kind: v.kind,
		provider: v.provider.trim(),
		accountNumber: v.accountNumber.trim() || null,
		dueDay: Number.isFinite(day) ? day : null,
		notes: v.notes.trim() || null,
	};
};
export const validateService = (v: ServiceFormValue): FieldErrors => {
	const errors: FieldErrors = {};
	if (!v.provider.trim()) errors.provider = 'home:error_provider';
	if (v.dueDay.trim()) {
		const day = Number(v.dueDay);
		if (!Number.isInteger(day) || day < 1 || day > 31) errors.dueDay = 'home:error_due_day';
	}
	return errors;
};

/** A preset ticked in an add form, with its first due date. */
export type PresetPicks = Record<string, PresetPickState>;
export const freshPicks = (presets: readonly (ObligationPreset & { id: string })[]): PresetPicks =>
	Object.fromEntries(presets.map((p) => [p.id, freshPick(p)]));
/** What a pick adds to an action input: the person's repeat and lead time. */
export const scheduleFor = (picks: PresetPicks, id: string) => {
	const pick = picks[id];
	return pick ? scheduleOfPick(pick) : {};
};
