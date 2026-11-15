import { fanSpeeds, type Value } from '../contract/index.js';

/**
 * A value of Home Assistant in words. Pure: the translator and the formatters come in, so the
 * language and the region format decide how it reads, and a test needs no browser.
 */

/** Catalog keys of the words a value can be said with. */
export type ValueWord =
	| 'value_unavailable'
	| 'value_speed'
	| 'value_never_run'
	| 'value_last_run'
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
	| 'value_cleaning'
	| 'value_docked'
	| 'value_returning'
	| 'value_paused'
	| 'value_idle'
	| 'value_error'
	| 'value_playing'
	| 'value_standby'
	| 'value_buffering'
	| 'value_connected'
	| 'value_disconnected'
	| 'value_on'
	| 'value_off'
	| 'value_percent'
	| OptionWord;

/** The words of the modes and presets Home Assistant names most often; any other is shown as it is. */
const OPTION_WORDS = [
	'auto',
	'sleep',
	'normal',
	'eco',
	'boost',
	'turbo',
	'away',
	'home',
	'comfort',
	'low',
	'medium',
	'high',
] as const;
type OptionWord = `option_${(typeof OPTION_WORDS)[number]}`;

/** A mode or preset in words: translated when it is one of the common ones, else as given. */
export function optionWords(word: string, t: (key: OptionWord) => string): string {
	const known = (OPTION_WORDS as readonly string[]).includes(word.toLowerCase());
	return known ? t(`option_${word.toLowerCase()}` as OptionWord) : word;
}

export interface WordDeps {
	t(key: ValueWord, params?: Record<string, string>): string;
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

/** State words of locks, covers, valves, vacuums, media players and thermostats; any other state is said as Home Assistant says it. */
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
	valve: {
		open: 'value_open',
		closed: 'value_closed',
		opening: 'value_opening',
		closing: 'value_closing',
	},
	vacuum: {
		cleaning: 'value_cleaning',
		docked: 'value_docked',
		returning: 'value_returning',
		paused: 'value_paused',
		idle: 'value_idle',
		error: 'value_error',
	},
	media_player: {
		playing: 'value_playing',
		paused: 'value_paused',
		idle: 'value_idle',
		on: 'value_on',
		off: 'value_off',
		standby: 'value_standby',
		buffering: 'value_buffering',
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

/** A mode is added to a humidifier's line only when it is short enough to fit beside the rest. */
const MODE_FITS = 8;

/** A whole percentage in words ("60 %"), in the family's region format. */
export const percentWords = (percent: number, deps: Pick<WordDeps, 't' | 'number'>): string =>
	deps.t('value_percent', { value: deps.number(percent) });

export function describeValue(value: Value, deps: WordDeps): ValueText {
	switch (value.kind) {
		case 'unavailable':
			return { text: deps.t('value_unavailable'), tone: 'soft' };
		case 'time':
			return { text: deps.time(value.at), tone: 'ink' };
		case 'lastRun':
			return value.at === null
				? { text: deps.t('value_never_run'), tone: 'soft' }
				: { text: deps.t('value_last_run', { time: deps.time(value.at) }), tone: 'ink' };
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
			const level = fanSpeeds(value)?.current;
			const preset = value.levels?.preset?.current;
			if (value.on && preset)
				return { text: optionWords(preset, (key) => deps.t(key)), tone: 'ink' };
			if (value.on && level)
				return { text: deps.t('value_speed', { level: String(level) }), tone: 'ink' };
			const alert = value.on && 'alertWhenOn' in words && words.alertWhenOn === true;
			const parts = [deps.t(value.on ? words.on : words.off)];
			if (value.on) {
				const brightness = value.levels?.brightness?.percent;
				const target = value.levels?.humidity?.target;
				if (brightness != null) parts.push(percentWords(brightness, deps));
				if (target != null) {
					parts.push(percentWords(target, deps));
					const mode = value.levels?.mode?.current;
					const said = mode ? optionWords(mode, (key) => deps.t(key)) : null;
					if (said && said.length <= MODE_FITS) parts.push(said);
				}
			}
			return { text: parts.join(' · '), tone: alert ? 'attention' : 'ink' };
		}
		case 'state': {
			const key = STATE_WORDS[value.domain]?.[value.state];
			const word = key ? deps.t(key) : value.state;
			const parts = [word];
			if (value.temperature !== null) parts.push(`${deps.number(value.temperature)}°`);
			// A cover or valve that is open says how far.
			const position = value.levels?.position?.percent;
			if (value.state === 'open' && position != null) parts.push(percentWords(position, deps));
			return {
				text: parts.join(' · '),
				// A jammed lock or cover, or a vacuum that stopped on an error, needs someone to look.
				tone: value.state === 'jammed' || value.state === 'error' ? 'attention' : 'ink',
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
