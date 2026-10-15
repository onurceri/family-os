import { describeRecurrence } from '@famos/time';
import type { DraftPresenter } from '@famos/ui/slots';
import { CalendarDays } from '@lucide/svelte';
import type { EventInput } from '../contract/index.js';
import { type ChangeEventInput, changeEventFields } from './change.js';
import { reminderKey } from './form.js';
import { describeWhen } from './format.js';
import { moveOffer } from './instead.js';

/** How a proposed event looks in the Inbox: its draft card. */
export const createEventPresenter: DraftPresenter<EventInput> = {
	actionId: 'calendar.createEvent',
	kind: (c) => c.t('calendar:kind'),
	icon: CalendarDays,
	title: (input) => input.title,
	fields(input, c) {
		const t = (key: string, options?: Record<string, unknown>) => c.t(`calendar:${key}`, options);
		const who = (input.memberIds ?? [])
			.map((id) => c.members.find((m) => m.id === id)?.displayName)
			.filter(Boolean)
			.join(', ');
		const fields = [
			{
				label: t('when'),
				value: describeWhen(input, c.dateLocale, t('all_day'), c.hourCycle),
				paths: ['date', 'endDate', 'startTime', 'endTime', 'allDay'],
			},
			{ label: t('who'), value: who || t('everyone'), path: 'memberIds' },
		];
		if (input.location) fields.push({ label: t('where'), value: input.location, path: 'location' });
		if (input.recurrence) {
			const recurrence = { interval: 1, ...input.recurrence } as Parameters<
				typeof describeRecurrence
			>[0];
			fields.push({
				label: t('repeat'),
				value: describeRecurrence(recurrence, t, c.dateLocale, c.weekStart),
				path: 'recurrence',
			});
		}
		if (input.reminder !== undefined && input.reminder !== null) {
			fields.push({
				label: t('reminder'),
				value: t(reminderKey(input.allDay ?? false, input.reminder)),
				path: 'reminder',
			});
		}
		if (input.tags?.length)
			fields.push({ label: t('tags'), value: input.tags.join(', '), path: 'tags' });
		if (input.notes) fields.push({ label: t('notes'), value: input.notes, path: 'notes' });
		return fields;
	},
	approveLabel: (c) => c.t('calendar:add_to_calendar'),
	editor: () => import('./DraftEditor.svelte'),
};

/** A proposed change to an existing event: only what changes is listed, as "old → new". */
export const changeEventPresenter: DraftPresenter<ChangeEventInput> = {
	actionId: 'calendar.changeEvent',
	kind: (c) => c.t('calendar:kind_change'),
	icon: CalendarDays,
	// The label is the model's copy of what it was shown; the id is what is acted on.
	title: (input, c) => input.label || input.title || c.t('calendar:draft_an_event'),
	fields: (input, c, before) => changeEventFields(input, c, before),
	approveLabel: (c) => c.t('calendar:draft_approve_change'),
	instead: moveOffer,
};

/** A proposal to remove an event, or one date of a repeating one. */
export const deleteEventPresenter: DraftPresenter<{
	id: string;
	occurrence?: string;
	label?: string;
}> = {
	actionId: 'calendar.deleteEvent',
	kind: (c) => c.t('calendar:kind_remove'),
	icon: CalendarDays,
	title: (input, c) => input.label || c.t('calendar:draft_an_event'),
	fields: (input, c) => [
		{
			label: c.t('calendar:draft_what'),
			value: input.occurrence ? c.t('calendar:draft_only_this') : c.t('calendar:draft_whole'),
			path: 'occurrence',
		},
	],
	approveLabel: (c) => c.t('calendar:draft_approve_remove'),
};
