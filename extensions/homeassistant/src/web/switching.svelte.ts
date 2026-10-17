import type { AppContext } from '@famos/ui/app';
import type { Operation, Values } from '../contract/index.js';
import { POLL_MS, SETTLE_MS, valueKey } from './controls.js';
import { switchItem } from './data.js';
import type { HomeAssistantT } from './i18n.js';

type Shown = Values['items'][number];

/**
 * Switching from a list of rows: asks for the switch, says "Switching…" on that row until the
 * value changes (reading every two seconds, for ten at most), and says what could not be switched.
 * Home Assistant is called by a job after the request, so the row learns the result from the next
 * read, or from the failure the server sends only to the person who switched.
 */
export function createSwitcher(options: {
	app: AppContext;
	t: HomeAssistantT;
	/** Reads the values again and returns them (null when they could not be read). */
	reload: () => Promise<Values | null>;
	/** The rows shown now, to name the one that failed. */
	shown: () => readonly Shown[];
}) {
	const { app, t } = options;
	const pending = $state<Record<string, true>>({});
	const timers = new Map<string, ReturnType<typeof setInterval>>();

	function settle(id: string) {
		clearInterval(timers.get(id));
		timers.delete(id);
		delete pending[id];
	}

	function fail(id: string) {
		const label = options.shown().find((item) => item.id === id)?.label;
		settle(id);
		if (label) app.toast(t('switch_failed', { name: label }));
	}

	async function run(item: Shown, operation: Operation) {
		if (pending[item.id]) return;
		pending[item.id] = true;
		const before = valueKey(item.value);
		try {
			await switchItem(item.id, operation);
		} catch {
			fail(item.id);
			return;
		}
		const started = Date.now();
		clearInterval(timers.get(item.id));
		timers.set(
			item.id,
			setInterval(async () => {
				const values = await options.reload();
				const now = values?.items.find((v) => v.id === item.id);
				if ((now && valueKey(now.value) !== before) || Date.now() - started >= SETTLE_MS)
					settle(item.id);
			}, POLL_MS),
		);
	}

	const off = app.onEvent('homeassistant.switch.failed', (_name, payload) => {
		const id = (payload as { id?: unknown } | null)?.id;
		if (typeof id === 'string') fail(id);
	});

	return {
		/** Whether the row is waiting for its switch. */
		busy: (id: string) => pending[id] === true,
		run,
		stop() {
			off();
			for (const timer of timers.values()) clearInterval(timer);
			timers.clear();
		},
	};
}
