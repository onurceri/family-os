import { type AppContext, namespaced, useApp } from '@famos/ui/app';
import type en from '../messages/en.json';

export type HomeAssistantT = ReturnType<typeof namespaced<typeof en>>;

/** The Home Assistant translator: keys are typed by the English catalog. */
export function useHomeAssistant(): { app: AppContext; t: HomeAssistantT } {
	const app = useApp();
	return { app, t: namespaced<typeof en>(app, 'homeassistant') };
}
