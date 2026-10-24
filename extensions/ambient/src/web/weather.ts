import { weatherKind } from '@famos/time';
import {
	Cloud,
	CloudDrizzle,
	CloudFog,
	CloudLightning,
	CloudMoon,
	CloudRain,
	CloudSnow,
	CloudSun,
	Moon,
	Sun,
} from '@lucide/svelte';
import type { Component } from 'svelte';

export type WeatherLabel =
	| 'wmo_clear'
	| 'wmo_mostly_clear'
	| 'wmo_partly_cloudy'
	| 'wmo_cloudy'
	| 'wmo_fog'
	| 'wmo_drizzle'
	| 'wmo_rain'
	| 'wmo_snow'
	| 'wmo_showers'
	| 'wmo_thunderstorm'
	| 'wmo_unknown';

/** WMO weather interpretation codes (Open-Meteo) as an icon and a message key. */
export function describeWeather(
	code: number,
	isDay = true,
): { icon: Component; label: WeatherLabel } {
	switch (weatherKind(code)) {
		case 'clear':
			return { icon: isDay ? Sun : Moon, label: code === 0 ? 'wmo_clear' : 'wmo_mostly_clear' };
		case 'partly':
			return { icon: isDay ? CloudSun : CloudMoon, label: 'wmo_partly_cloudy' };
		case 'fog':
			return { icon: CloudFog, label: 'wmo_fog' };
		case 'drizzle':
			return { icon: CloudDrizzle, label: 'wmo_drizzle' };
		case 'rain':
			return { icon: CloudRain, label: code >= 80 ? 'wmo_showers' : 'wmo_rain' };
		case 'snow':
			return { icon: CloudSnow, label: 'wmo_snow' };
		case 'storm':
			return { icon: CloudLightning, label: 'wmo_thunderstorm' };
		default:
			return { icon: Cloud, label: code === 3 ? 'wmo_cloudy' : 'wmo_unknown' };
	}
}
