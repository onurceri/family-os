import { addDays, compareDates, daysBetween, formatDate } from '@famos/time';
import type { Obligation } from '../contract/index.js';
import type { RecordsT } from './i18n.js';

/** `ended`: a date that only passes (a warranty ends) is behind us; it is never `overdue`. */
export type DueStatus = 'overdue' | 'soon' | 'ok' | 'ended';

type Dated = Pick<Obligation, 'dueDate' | 'leadDays' | 'lapses'>;

/** Overdue (or ended); "soon" once the reminder lead time has begun; otherwise fine. */
export function dueStatus(o: Dated, today: string): DueStatus {
	if (compareDates(o.dueDate, today) < 0) return o.lapses ? 'ended' : 'overdue';
	return compareDates(o.dueDate, addDays(today, o.leadDays)) <= 0 ? 'soon' : 'ok';
}

/** Still ahead or due today, or a duty that is late: what the lists of things to come show. */
export const stillMatters = (o: Dated, today: string) => dueStatus(o, today) !== 'ended';

/** "3 days overdue", "Today", "Tomorrow", "in 12 days · 12 Nov", "Ended on 12 Apr 2025". */
export function dueLabel(
	o: Pick<Obligation, 'dueDate' | 'lapses'>,
	today: string,
	t: RecordsT,
	locale: string,
): string {
	const days = daysBetween(today, o.dueDate);
	const date = formatDate(o.dueDate, locale, { day: 'numeric', month: 'short', year: 'numeric' });
	if (days < 0 && o.lapses) return t('ended_on', { date });
	if (days < -1) return t('overdue_days', { count: -days, date });
	if (days === -1) return t('due_yesterday', { date });
	if (days === 0) return t('due_today');
	if (days === 1) return t('due_tomorrow');
	return t('due_in_days', { count: days, date });
}

/** State text of a row meta: 13/700, one per row. */
export const stateTextClass = (status: DueStatus) =>
	status === 'overdue'
		? 'text-attention font-bold'
		: status === 'soon'
			? 'font-bold text-heat-ink'
			: '';

export const statusClass = (status: DueStatus) =>
	status === 'overdue'
		? 'text-attention font-semibold'
		: status === 'soon'
			? 'text-ink font-semibold'
			: 'text-ink-soft';
