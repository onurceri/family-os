import type { Value } from '../contract/index.js';

/**
 * A value of Home Assistant in words. Pure: the translator and the formatters come in, so the
 * language and the region format decide how it reads, and a test needs no browser.
 */

/** Catalog keys of the words a value can be said with. */
export type ValueWord =
	| 'value_unavailable'
	| 'value_open'
	| 'value_closed'
	| 'value_detected'
	| 'value_clear'
	| 'value_wet'
	| 'value_dry'
	| 'value_heat'
	| 'value_cool'
	| 'value_heat_cool'
	| 'value_auto'
	| 'value_dry_mode'
	| 'value_fan_only'
	| 'value_alert'
	| 'value_ok'
	| 'value_low'
	| 'value_normal'
	| 'value_unlocked'
	| 'value_locked'
	| 'value_jammed'
	| 'value_locking'
	| 'value_unlocking'
	| 'value_opening'
	| 'value_closing'
	| 'value_connected'
	| 'value_disconnected'
	| 'value_on'
	| 'value_off';

export interface WordDeps {
	t(key: ValueWord): string;
	/** A number in the family's region format. */
	number(value: number): string;
	/** A time in the family's region format, relative to today. */
	time(at: number): string;
}

/** `attention` is for a state that needs a look; `soft` for what is not there. */
export type ValueTone = 'ink' | 'soft' | 'attention';

export interface ValueText {
	text: string;
	tone: ValueTone;
}

/** The words for on and off by device class; the rest read On and Off. */
const BINARY: Record<string, { on: ValueWord; off: ValueWord; alertWhenOn?: boolean }> = {
	door: { on: 'value_open', off: 'value_closed' },
	garage_door: { on: 'value_open', off: 'value_closed' },
	opening: { on: 'value_open', off: 'value_closed' },
	window: { on: 'value_open', off: 'value_closed' },
	motion: { on: 'value_detected', off: 'value_clear' },
	occupancy: { on: 'value_detected', off: 'value_clear' },
	presence: { on: 'value_detected', off: 'value_clear' },
	sound: { on: 'value_detected', off: 'value_clear' },
	vibration: { on: 'value_detected', off: 'value_clear' },
	tamper: { on: 'value_detected', off: 'value_clear' },
	moisture: { on: 'value_wet', off: 'value_dry' },
	smoke: { on: 'value_alert', off: 'value_ok', alertWhenOn: true },
	gas: { on: 'value_alert', off: 'value_ok', alertWhenOn: true },
	carbon_monoxide: { on: 'value_alert', off: 'value_ok', alertWhenOn: true },
	safety: { on: 'value_alert', off: 'value_ok', alertWhenOn: true },
	problem: { on: 'value_alert', off: 'value_ok', alertWhenOn: true },
	battery: { on: 'value_low', off: 'value_normal', alertWhenOn: true },
	// For a lock, Home Assistant's "on" means unlocked.
	lock: { on: 'value_unlocked', off: 'value_locked' },
	connectivity: { on: 'value_connected', off: 'value_disconnected' },
};

/** State words of locks and covers; any other state is said as Home Assistant says it. */
const STATE_WORDS: Record<string, Record<string, ValueWord>> = {
	lock: {
		locked: 'value_locked',
		unlocked: 'value_unlocked',
		jammed: 'value_jammed',
		locking: 'value_locking',
		unlocking: 'value_unlocking',
		open: 'value_open',
		opening: 'value_opening',
	},
	cover: {
		open: 'value_open',
		closed: 'value_closed',
		opening: 'value_opening',
		closing: 'value_closing',
	},
	// Home Assistant's HVAC modes, a fixed list of its own.
	climate: {
		off: 'value_off',
		heat: 'value_heat',
		cool: 'value_cool',
		heat_cool: 'value_heat_cool',
		auto: 'value_auto',
		dry: 'value_dry_mode',
		fan_only: 'value_fan_only',
	},
};

export function describeValue(value: Value, deps: WordDeps): ValueText {
	switch (value.kind) {
		case 'unavailable':
			return { text: deps.t('value_unavailable'), tone: 'soft' };
		case 'time':
			return { text: deps.time(value.at), tone: 'ink' };
		case 'number':
			return {
				text: value.unit ? `${deps.number(value.value)} ${value.unit}` : deps.number(value.value),
				tone: 'ink',
			};
		case 'binary': {
			const words = (value.deviceClass && BINARY[value.deviceClass]) || {
				on: 'value_on' as const,
				off: 'value_off' as const,
			};
			const alert = value.on && 'alertWhenOn' in words && words.alertWhenOn === true;
			return {
				text: deps.t(value.on ? words.on : words.off),
				tone: alert ? 'attention' : 'ink',
			};
		}
		case 'state': {
			const key = STATE_WORDS[value.domain]?.[value.state];
			const word = key ? deps.t(key) : value.state;
			return {
				text: value.temperature === null ? word : `${word} · ${deps.number(value.temperature)}°`,
				tone: value.state === 'jammed' ? 'attention' : 'ink',
			};
		}
		case 'text':
			return { text: value.text, tone: 'ink' };
	}
}

/** What the page needs to say a time: today as a clock time, another day with its date. */
export function timeWords(
	at: number,
	now: number,
	dateLocale: string,
	hourCycle: 'h12' | 'h23',
	timeZone: string,
): string {
	const day = new Intl.DateTimeFormat(dateLocale, {
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
		timeZone,
	});
	const clock = { hour: '2-digit', minute: '2-digit', hourCycle, timeZone } as const;
	if (day.format(at) === day.format(now))
		return new Intl.DateTimeFormat(dateLocale, clock).format(at);
	return new Intl.DateTimeFormat(dateLocale, { day: 'numeric', month: 'short', ...clock }).format(
		at,
	);
}

/** A number with at most one decimal (two significant digits below one), in the family's region format. */
export const numberWords = (value: number, formatLocale: string): string =>
	new Intl.NumberFormat(
		formatLocale,
		// Below one, a decimal would round a small reading away (0.003 MWh is not 0).
		Math.abs(value) < 1 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 1 },
	).format(value);
