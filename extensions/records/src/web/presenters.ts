import { type DraftPresenter, draftDate } from '@famos/ui/slots';
import { CalendarClock } from '@lucide/svelte';
import type { AddObligationInput } from '../contract/index.js';

/** How a supervised member's suggestion to add a duty to a record reads in the Inbox. */
export const addObligationPresenter: DraftPresenter<AddObligationInput> = {
	actionId: 'records.addObligation',
	kind: (c) => c.t('records:kind_obligation'),
	icon: CalendarClock,
	title: (input) => input.title,
	fields: (input, c) => [
		{ label: c.t('records:draft_record'), value: input.recordName, path: 'recordName' },
		{ label: c.t('records:field_due_date'), value: draftDate(input.dueDate, c), path: 'dueDate' },
	],
	approveLabel: (c) => c.t('records:draft_approve_add'),
};

type CompleteInput = { id: string; label?: string; doneOn?: string; nextDueDate?: string };

export const completeObligationPresenter: DraftPresenter<CompleteInput> = {
	actionId: 'records.completeObligation',
	kind: (c) => c.t('records:kind_obligation'),
	icon: CalendarClock,
	// The entry's name is the model's copy of what it was shown; the id is what is acted on.
	title: (input, c) =>
		input.label
			? `${input.label}: ${c.t('records:draft_complete_title')}`
			: c.t('records:draft_complete_title'),
	fields: (input, c) => [
		...(input.doneOn
			? [{ label: c.t('records:field_done_on'), value: draftDate(input.doneOn, c), path: 'doneOn' }]
			: []),
		...(input.nextDueDate
			? [
					{
						label: c.t('records:field_next_due'),
						value: draftDate(input.nextDueDate, c),
						path: 'nextDueDate',
					},
				]
			: []),
	],
	approveLabel: (c) => c.t('records:mark_done'),
};
