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
	| 'history_open_valve'
	| 'history_close_valve'
	| 'history_stop_valve'
	| 'history_start'
	| 'history_pause'
	| 'history_return_to_base'
	| 'history_media_play'
	| 'history_media_pause'
	| 'history_press'
	| 'history_set_percentage'
	| 'history_set_value'
	| 'history_set_volume'
	| 'history_run';

/** What a switch set to, by kind: a percentage or one of a list of words. */
const SETS_NUMBER = new Set(['set_cover_position', 'set_valve_position', 'set_humidity']);
const SETS_WORD = new Set(['set_mode', 'set_preset_mode']);

/**
 * Scenes and scripts are run, not turned on; a light switched on with a brightness is set to it.
 * `chosen` is what the switch set, when it set something.
 */
export function historyKey(
	entityId: string,
	operation: Operation,
	chosen?: string | null,
): HistoryKey {
	const domain = controlDomain(entityId);
	if ((domain === 'scene' || domain === 'script') && operation === 'turn_on') return 'history_run';
	if (operation === 'volume_set') return 'history_set_volume';
	if (SETS_NUMBER.has(operation) || SETS_WORD.has(operation)) return 'history_set_value';
	if (operation === 'turn_on' && chosen != null) return 'history_set_value';
	return `history_${operation}` as HistoryKey;
}

export interface HistoryDeps {
	t(
		key: HistoryKey | 'history_failed' | 'history_someone',
		params?: Record<string, string>,
	): string;
	/** A whole percentage in words ("60 %"). */
	percent(value: number): string;
	/** A mode or a preset in words. */
	option(word: string): string;
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
	const chosen = entry.chosen ?? null;
	const number = chosen !== null && !SETS_WORD.has(entry.operation) ? Number(chosen) : null;
	const value =
		chosen === null
			? ''
			: number !== null && Number.isFinite(number)
				? deps.percent(number)
				: deps.option(chosen);
	return {
		title: deps.t(historyKey(entry.entityId, entry.operation, chosen), {
			who: who ?? deps.t('history_someone'),
			name: entry.label,
			level: String(entry.level ?? ''),
			value,
		}),
		meta: when,
	};
}
