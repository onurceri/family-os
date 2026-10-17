import { describe, expect, it } from 'vitest';
import { groupTasks, movedToHiddenCart } from '../src/web/format.ts';
import { listPagePath, rememberedListPage, rememberListPage } from '../src/web/lists-page.ts';

function memory() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
	};
}

describe('the Lists tab remembers the page used last', () => {
	it('opens Shopping until a page was used', () => {
		expect(rememberedListPage(memory())).toBe('shopping');
		expect(rememberedListPage(null)).toBe('shopping');
	});

	it('opens the page used last on this device', () => {
		const store = memory();
		rememberListPage('tasks', store);
		expect(rememberedListPage(store)).toBe('tasks');
		rememberListPage('shopping', store);
		expect(rememberedListPage(store)).toBe('shopping');
		expect(listPagePath(rememberedListPage(store))).toBe('/lists/shopping');
	});

	it('ignores a value it does not know and storage that refuses', () => {
		const store = memory();
		store.setItem('famos.lists.page', 'calendar');
		expect(rememberedListPage(store)).toBe('shopping');
		const refusing = {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('blocked');
			},
		};
		expect(() => rememberListPage('tasks', refusing)).not.toThrow();
		expect(rememberedListPage(refusing)).toBe('shopping');
	});
});

describe('groupTasks', () => {
	const today = '2026-10-10';
	const task = (
		title: string,
		dueDate: string | null,
		extra: { dueTime?: string; doneAt?: number; assigneeId?: string } = {},
	) => ({
		title,
		dueDate,
		dueTime: extra.dueTime ?? null,
		doneAt: extra.doneAt ?? null,
		assigneeId: extra.assigneeId ?? null,
	});
	const tasks = [
		task('no date', null),
		task('later', '2026-10-30'),
		task('this week', '2026-10-11'),
		task('today late', today, { dueTime: '18:00' }),
		task('today early', today, { dueTime: '08:00', assigneeId: 'm1' }),
		task('today any time', today),
		task('overdue', '2026-10-08', { assigneeId: 'm1' }),
		task('done', '2026-10-08', { doneAt: 1 }),
	];
	const titles = (groups: ReturnType<typeof groupTasks<(typeof tasks)[number]>>) =>
		groups.map((g) => [g.key, g.tasks.map((t) => t.title)]);

	it('groups the open tasks by when they are due, earliest first', () => {
		expect(titles(groupTasks(tasks, today, 1))).toEqual([
			['overdue', ['overdue']],
			['today', ['today early', 'today late', 'today any time']],
			['soon', ['this week']],
			['later', ['later']],
			['none', ['no date']],
		]);
	});

	it('shows only one person’s tasks for Mine and leaves out empty groups', () => {
		expect(titles(groupTasks(tasks, today, 1, 'm1'))).toEqual([
			['overdue', ['overdue']],
			['today', ['today early']],
		]);
		expect(groupTasks([task('done', null, { doneAt: 1 })], today, 1)).toEqual([]);
	});

	it('ends this week on the last day of the family’s week', () => {
		// Saturday 17 October: with weeks from Monday, only Sunday is left of this week.
		const saturday = '2026-10-17';
		const coming = [task('Sunday', '2026-10-18'), task('Tuesday', '2026-10-20')];
		expect(titles(groupTasks(coming, saturday, 1))).toEqual([
			['soon', ['Sunday']],
			['later', ['Tuesday']],
		]);
		// With weeks from Saturday, the whole coming week up to Friday is this week.
		const week = [task('Friday', '2026-10-23'), task('next Saturday', '2026-10-24')];
		expect(titles(groupTasks(week, saturday, 6))).toEqual([
			['soon', ['Friday']],
			['later', ['next Saturday']],
		]);
	});
});

describe('movedToHiddenCart', () => {
	it('says so only when a tick went through and the cart is folded away', () => {
		expect(movedToHiddenCart(true, 'applied', false)).toBe(true);
		expect(movedToHiddenCart(true, 'applied', true)).toBe(false);
		expect(movedToHiddenCart(false, 'applied', false)).toBe(false);
		expect(movedToHiddenCart(true, 'queued', false)).toBe(false);
		expect(movedToHiddenCart(true, 'drafted', false)).toBe(false);
	});
});
