import { MINUTE_MS } from '@famos/time';

/**
 * The current time as epoch milliseconds, refreshed every `everyMs` (a minute by default) while the
 * component that called this is on screen. Call it while a component initializes and read
 * `clock.current` in a template, `$derived` or effect.
 */
export function useNow(everyMs: number = MINUTE_MS): { readonly current: number } {
	let now = $state(Date.now());
	$effect(() => {
		now = Date.now();
		const timer = setInterval(() => (now = Date.now()), everyMs);
		return () => clearInterval(timer);
	});
	return {
		get current() {
			return now;
		},
	};
}
