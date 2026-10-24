/** What a WMO weather interpretation code (Open-Meteo) looks like, in the words a view needs. */
export type WeatherKind =
	| 'clear'
	| 'partly'
	| 'cloud'
	| 'fog'
	| 'drizzle'
	| 'rain'
	| 'snow'
	| 'storm';

/**
 * The kind of a WMO weather code: clear (0, 1), partly cloudy (2), fog, drizzle (51-57), rain
 * (61-67 and the showers 80-82), snow (71-77, 85, 86) and storm (95-99). Overcast (3) and a code
 * it does not know are `cloud`: never a wrong promise of sun.
 */
export function weatherKind(code: number): WeatherKind {
	if (code === 0 || code === 1) return 'clear';
	if (code === 2) return 'partly';
	if (code === 45 || code === 48) return 'fog';
	if (code >= 51 && code <= 57) return 'drizzle';
	if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
	if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
	if (code >= 95 && code <= 99) return 'storm';
	return 'cloud';
}

/** Whether the code falls (drizzle, rain, snow or storm). */
export const isWetCode = (code: number): boolean => {
	const kind = weatherKind(code);
	return kind === 'drizzle' || kind === 'rain' || kind === 'snow' || kind === 'storm';
};
