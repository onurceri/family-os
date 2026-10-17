import type { Value } from '../contract/index.js';
import type { HomeAssistantT } from './i18n.js';
import { describeValue, numberWords, timeWords, type ValueText } from './words.js';

/** The minimal app services saying a value needs. */
interface SayApp {
	formatLocale(): string;
	dateLocale(): string;
	hourCycle(): 'h12' | 'h23';
	timeZone(): string;
}

/** A value in the reader's language and the family's region format. */
export function sayValue(app: SayApp, t: HomeAssistantT, value: Value): ValueText {
	return describeValue(value, {
		t: (key) => t(key),
		number: (n) => numberWords(n, app.formatLocale()),
		time: (at) => timeWords(at, Date.now(), app.dateLocale(), app.hourCycle(), app.timeZone()),
	});
}

/** The token classes of a value's tone. */
export const TONE_CLASS = {
	ink: 'text-ink',
	soft: 'text-ink-soft',
	attention: 'text-attention',
} as const;
