import { DEFAULT_LEAD_DAYS, type Obligation, type ObligationPreset } from '../contract/index.js';
import type { ObligationFields } from './data.js';

import type { RepeatUnit } from './repeat.js';

export type { RepeatUnit };

/** The obligation form as the inputs hold it. */
export interface ObligationFormValue {
	kind: string;
	title: string;
	dueDate: string;
	repeat: RepeatUnit;
	interval: number;
	leadDays: number;
	assignee: string[];
	notes: string;
}

export const emptyObligation = (): ObligationFormValue => ({
	kind: 'custom',
	title: '',
	dueDate: '',
	repeat: 'none',
	interval: 1,
	leadDays: DEFAULT_LEAD_DAYS,
	assignee: [],
	notes: '',
});

/** A preset's title is translated by the caller (it belongs to the domain's catalog). */
export function fromPreset(preset: ObligationPreset, title: string): ObligationFormValue {
	const every = preset.every;
	return {
		...emptyObligation(),
		kind: preset.id,
		title,
		repeat: every?.months ? 'months' : every?.years ? 'years' : 'none',
		interval: every?.months ?? every?.years ?? 1,
		leadDays: preset.leadDays ?? DEFAULT_LEAD_DAYS,
	};
}

export const fromObligation = (o: Obligation): ObligationFormValue => ({
	kind: o.kind,
	title: o.title,
	dueDate: o.dueDate,
	repeat: o.every?.months ? 'months' : o.every?.years ? 'years' : 'none',
	interval: o.every?.months ?? o.every?.years ?? 1,
	leadDays: o.leadDays,
	assignee: o.assigneeId ? [o.assigneeId] : [],
	notes: o.notes ?? '',
});

export function toFields(v: ObligationFormValue): ObligationFields {
	const interval = Math.max(1, Math.round(v.interval) || 1);
	return {
		kind: v.kind,
		title: v.title.trim(),
		dueDate: v.dueDate,
		every:
			v.repeat === 'months'
				? { months: interval }
				: v.repeat === 'years'
					? { years: interval }
					: null,
		leadDays: Math.max(0, Math.round(v.leadDays) || 0),
		assigneeId: v.assignee[0] ?? null,
		notes: v.notes.trim() || null,
	};
}

/** Input paths that are wrong, for marking fields. */
export function validate(v: ObligationFormValue): Record<string, true> {
	const errors: Record<string, true> = {};
	if (!v.title.trim()) errors.title = true;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(v.dueDate)) errors.dueDate = true;
	return errors;
}
