import type { paths } from '@famos/api-client';
import { defaultHourCycle, defaultTemperatureUnit, defaultWeekStart } from '@famos/time';
import { api } from './api';
import { regionFormatLocale } from './region';

type Member =
	paths['/api/v1/core/members']['get']['responses'][200]['content']['application/json'][number];

/** The browser's preferred languages, most preferred first (`sl-SI`, `en-GB`, `en`). */
export function browserLocales(): readonly string[] {
	if (typeof navigator === 'undefined') return [];
	return navigator.languages?.length ? navigator.languages : [navigator.language];
}

/** The browser's region format (`sl-SI`, `de-DE`), the starting point at setup. */
export function browserFormatLocale(): string {
	return regionFormatLocale(browserLocales());
}

/** Family-wide data most screens need: active members and the family time zone. */
class Family {
	members = $state<Member[]>([]);
	/** The family's default language (a code with a language pack); English until settings arrive. */
	locale = $state('en');
	/** Whether the family settings have been read at least once. */
	loaded = $state(false);
	timeZone = $state(Intl.DateTimeFormat().resolvedOptions().timeZone);
	// Until the family's settings arrive, the browser's own region.
	formatLocale = $state(browserFormatLocale());
	weekStart = $state(defaultWeekStart(browserFormatLocale()));
	hourCycle = $state<'h12' | 'h23'>(defaultHourCycle(browserFormatLocale()));
	temperatureUnit = $state<'celsius' | 'fahrenheit'>(defaultTemperatureUnit(browserFormatLocale()));

	/** Takes the region formats of the family settings. */
	apply(settings: {
		formatLocale: string;
		weekStart: number;
		hourCycle: 'h12' | 'h23';
		temperatureUnit: 'celsius' | 'fahrenheit';
	}): void {
		this.formatLocale = settings.formatLocale;
		this.weekStart = settings.weekStart;
		this.hourCycle = settings.hourCycle;
		this.temperatureUnit = settings.temperatureUnit;
	}

	async refresh(): Promise<void> {
		const [members, settings] = await Promise.all([
			api.GET('/api/v1/core/members'),
			api.GET('/api/v1/core/settings/family'),
		]);
		// The same members again keep the same array, so nothing that reads them runs again.
		const next = members.data ?? [];
		if (JSON.stringify(next) !== JSON.stringify(this.members)) this.members = next;
		if (settings.data) {
			this.timeZone = settings.data.timeZone;
			this.locale = settings.data.locale;
			this.loaded = true;
			this.apply(settings.data);
		}
	}
}

export const family = new Family();
