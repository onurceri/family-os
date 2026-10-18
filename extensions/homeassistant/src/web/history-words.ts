import { controlDomain, type Operation, type SwitchEntry } from '../contract/index.js';

/** The catalog key that says a switch that went through ("{{who}} turned on {{name}}"). */
export type HistoryKey =
	| 'history_turn_on'
	| 'history_turn_off'
	| 'history_open_cover'
	| 'history_close_cover'
	| 'history_stop_cover'
	| 'history_lock'
	| 'history_unlock'
	| 'history_run';

/** Scenes and scripts are run, not turned on. */
export function historyKey(entityId: string, operation: Operation): HistoryKey {
	const domain = controlDomain(entityId);
	if ((domain === 'scene' || domain === 'script') && operation === 'turn_on') return 'history_run';
	return `history_${operation}`;
}

export interface HistoryDeps {
	t(
		key: HistoryKey | 'history_failed' | 'history_someone',
		params?: Record<string, string>,
	): string;
	/** The member's name, or null when they are gone or may not be named. */
	member(memberId: string | null): string | null;
	time(at: number): string;
}

/**
 * One switch in words: "Tom turned on Living room light", "Mara ran Movie night", or, when it
 * could not be done, "Could not switch Living room light". `meta` is when, and for a failure
 * also who asked.
 */
export function describeSwitch(
	entry: SwitchEntry,
	deps: HistoryDeps,
): { title: string; meta: string } {
	const who = deps.member(entry.memberId);
	const when = deps.time(entry.at);
	if (!entry.ok)
		return {
			title: deps.t('history_failed', { name: entry.label }),
			meta: who ? `${who} · ${when}` : when,
		};
	return {
		title: deps.t(historyKey(entry.entityId, entry.operation), {
			who: who ?? deps.t('history_someone'),
			name: entry.label,
		}),
		meta: when,
	};
}
