import { describe, expect, it } from 'vitest';
import en from '../src/messages/en.json' with { type: 'json' };
import { updateTaskFields } from '../src/web/task-change.ts';

// Words as the app gives them: the key's English with its parameters filled in.
const words = en as Record<string, string>;
const context = {
	t: (key: string, options: Record<string, unknown> = {}) =>
		(words[key.replace(/^lists:/, '')] ?? key).replace(/{{(\w+)}}/g, (_, name) =>
			String(options[name]),
		),
	members: [],
	formatLocale: 'en-GB',
	dateLocale: 'en-GB',
	weekStart: 1,
	hourCycle: 'h23' as const,
	timeZone: 'Europe/Istanbul',
};

const repeatRow = (task: object, before: Record<string, unknown>) =>
	updateTaskFields(
		{ id: 'task_1', task: { title: 'Bins', ...task } as never },
		context,
		before,
	).find((f) => f.path === 'recurrence')?.to;

describe('a repeat in a change to a task', () => {
	it('names the weekday once when the task is due on it', () => {
		// 2026-10-22 is a Thursday.
		expect(
			repeatRow(
				{ dueDate: '2026-10-22', recurrence: { freq: 'weekly', byDay: ['TH'] } },
				{ recurrence: null, dueDate: '2026-10-22' },
			),
		).toBe('Every Thursday');
	});

	it('lists the days when they differ from the due day', () => {
		expect(
			repeatRow(
				{ dueDate: '2026-10-22', recurrence: { freq: 'weekly', byDay: ['MO'] } },
				{ recurrence: null, dueDate: '2026-10-22' },
			),
		).toBe('Every week · Mon');
	});
});
