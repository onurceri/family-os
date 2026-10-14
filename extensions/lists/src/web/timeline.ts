import { epochOf } from '@famos/time';
import type { TimelineContribution } from '@famos/ui/slots';
import { loadTasks } from './data.js';

/** Open tasks that are due at a time of day, on the day's timeline on Today. */
export const tasksTimeline: TimelineContribution = {
	id: 'lists.timedTasks',
	requires: 'lists.view',
	invalidateOn: ['lists.task.'],
	async load(day, app) {
		const tasks = await loadTasks();
		return tasks
			.filter((task) => task.doneAt === null && task.dueDate === day && task.dueTime)
			.map((task) => ({
				id: `lists:${task.id}`,
				start: epochOf(day, task.dueTime as string, app.timeZone()),
				title: task.title,
				members: task.assigneeId ? [task.assigneeId] : [],
				kind: 'task' as const,
				href: '/lists/tasks',
			}));
	},
};
