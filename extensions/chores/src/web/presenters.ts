import { changed, type DraftPresenter, draftDate } from '@famos/ui/slots';
import { SquareCheckBig, Users } from '@lucide/svelte';
import type { CreateChoreInput } from '../contract/index.js';

const nameOf = (members: readonly { id: string; displayName: string }[], id: string) =>
	members.find((m) => m.id === id)?.displayName ?? '';

/** A chore the AI or a person suggests. */
export const createChorePresenter: DraftPresenter<CreateChoreInput> = {
	actionId: 'chores.createChore',
	kind: (c) => c.t('chores:kind_chore'),
	icon: SquareCheckBig,
	title: (input) => input.title,
	fields: (input, c) => [
		{
			label: c.t('chores:draft_first_due'),
			value: draftDate(input.startDate, c),
			path: 'startDate',
		},
		...(input.recurrence
			? [
					{
						label: c.t('chores:draft_repeat'),
						value: c.t(`chores:repeat_${input.recurrence.freq}`),
					},
				]
			: []),
		...(input.assigneeIds?.length
			? [
					{
						label: c.t('chores:draft_people'),
						value: input.assigneeIds.map((id) => nameOf(c.members, id)).join(' → '),
						path: 'assigneeIds',
					},
				]
			: []),
		...(input.rotation && input.assigneeIds && input.assigneeIds.length > 1
			? [
					{
						label: c.t('chores:draft_rotation'),
						value: c.t(`chores:rotation_${input.rotation}`),
						path: 'rotation',
					},
				]
			: []),
	],
	approveLabel: (c) => c.t('chores:draft_approve_chore'),
};

interface SetAssigneesDraft {
	id: string;
	memberIds: string[];
	choreTitle?: string | undefined;
	/** The chore's name on record, stored with the draft. */
	label?: string | undefined;
}

/** A proposed split: who takes turns on a chore, "who now → who then" while it waits. */
export const setAssigneesPresenter: DraftPresenter<SetAssigneesDraft> = {
	actionId: 'chores.setAssignees',
	kind: (c) => c.t('chores:kind_split'),
	icon: Users,
	title: (input, c) => input.label || input.choreTitle || c.t('chores:draft_a_chore'),
	fields: (input, c, before) => {
		const people = (ids: readonly string[]) =>
			ids.length ? ids.map((id) => nameOf(c.members, id)).join(', ') : c.t('chores:anyone');
		const was = Array.isArray(before?.memberIds) ? (before.memberIds as string[]) : undefined;
		return [
			{
				label: c.t('chores:draft_people'),
				...changed(was && people(was), people(input.memberIds)),
				path: 'memberIds',
			},
		];
	},
	approveLabel: (c) => c.t('chores:draft_approve_split'),
};

/** A proposal to mark a chore done. */
export const markDonePresenter: DraftPresenter<{
	id: string;
	dueDate: string;
	doneBy?: string;
	label?: string;
}> = {
	actionId: 'chores.markDone',
	kind: (c) => c.t('chores:kind_chore'),
	icon: SquareCheckBig,
	title: (input, c) => input.label || c.t('chores:draft_a_chore'),
	// The turn that is marked done, since a repeating chore has one every time.
	fields: (input, c) => [
		{ label: c.t('chores:draft_due'), value: draftDate(input.dueDate, c), path: 'dueDate' },
		...(input.doneBy
			? [
					{
						label: c.t('chores:draft_done_by'),
						value: nameOf(c.members, input.doneBy),
						path: 'doneBy',
					},
				]
			: []),
	],
	approveLabel: (c) => c.t('chores:draft_approve_done'),
};
