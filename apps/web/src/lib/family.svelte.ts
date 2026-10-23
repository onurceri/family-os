import type { paths } from '@famos/api-client';
import { defaultHourCycle, defaultTemperatureUnit, defaultWeekStart } from '@famos/time';
import { api } from './api';
import { familyAddress } from './family-address';
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
	/** What the family is called, when it chose a name. */
	name = $state<string | null>(null);
	timeZone = $state(Intl.DateTimeFormat().resolvedOptions().timeZone);
	// Until the family's settings arrive, the browser's own region.
	formatLocale = $state(browserFormatLocale());
	weekStart = $state(defaultWeekStart(browserFormatLocale()));
	hourCycle = $state<'h12' | 'h23'>(defaultHourCycle(browserFormatLocale()));
	temperatureUnit = $state<'celsius' | 'fahrenheit'>(defaultTemperatureUnit(browserFormatLocale()));
	/** The address the server was told the family uses (`FAMOS_BASE_URL`); null when none is set. */
	configuredAddress = $state<string | null>(null);

	/** What to copy for another device or program: the configured address, else this browser's. */
	get familyAddress(): string {
		return familyAddress(
			this.configuredAddress,
			typeof location === 'undefined' ? '' : location.origin,
		);
	}

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
		const [members, settings, address] = await Promise.all([
			api.GET('/api/v1/core/members'),
			api.GET('/api/v1/core/settings/family'),
			api.GET('/api/v1/core/devices/address'),
		]);
		if (address.data) this.configuredAddress = address.data.url;
		// The same members again keep the same array, so nothing that reads them runs again.
		const next = members.data ?? [];
		if (JSON.stringify(next) !== JSON.stringify(this.members)) this.members = next;
		if (settings.data) {
			this.timeZone = settings.data.timeZone;
			this.locale = settings.data.locale;
			this.name = settings.data.name ?? null;
			this.loaded = true;
			this.apply(settings.data);
		}
	}
}

export const family = new Family();
