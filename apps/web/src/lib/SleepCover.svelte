<script lang="ts">
	import { formatTime, type HourCycle } from '@famos/time';
	import { t } from '#lib/i18n.svelte.js';
	import { type Awake, isDark, nextCheck, type SleepWindow, wakesAt, wokenAt } from './sleep.js';

	/**
	 * The dark screen of a device's sleep hours: pure black over everything, in the family's time
	 * zone, until the window ends. A touch, click or key wakes the device for a minute and presses
	 * nothing: the whole tap is caught here and the app underneath, which stays mounted, is as it
	 * was. Any use while it is awake keeps it awake; a minute without use turns it black again. It
	 * is a modal dialog so that it also covers the dialogs and panels that are open, and
	 * everything under it is out of reach of a screen reader and the keyboard. `dark` tells the
	 * page, which then mounts no photos while the screen is black.
	 */
	let {
		hours,
		timeZone,
		locale,
		hourCycle,
		dark = $bindable(false),
	}: {
		hours: SleepWindow | null;
		timeZone: string;
		/** The date locale (words of the reader's language, the family's clock). */
		locale: string;
		hourCycle: HourCycle;
		dark?: boolean;
	} = $props();

	let awake: Awake = null;
	/** A tap that woke the device is still going on: the black stays until it is over. */
	let tapping = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let tapEnd: ReturnType<typeof setTimeout> | undefined;
	let lastUse = 0;
	/** When a clock change or a throttled timer leaves the timer wrong, it is right again soon. */
	const LOOK_AGAIN_MS = 60_000;

	function evaluate() {
		clearTimeout(timer);
		timer = undefined;
		const now = Date.now();
		if (!tapping) dark = isDark(now, timeZone, hours, awake);
		const next = nextCheck(now, timeZone, hours, awake);
		if (next === null) return;
		timer = setTimeout(evaluate, Math.min(Math.max(next - now, 500), LOOK_AGAIN_MS));
	}

	// A new window or zone is applied at once; what the last touch started is kept, so someone
	// who sets the hours on this very device is not sent into the dark by doing it.
	$effect(() => {
		void hours?.from;
		void hours?.until;
		void timeZone;
		evaluate();
		return () => {
			clearTimeout(timer);
			clearTimeout(tapEnd);
			tapping = false;
			dark = false;
		};
	});

	const WAKES = ['pointerdown', 'touchstart', 'keydown'];
	const TAP = [
		...WAKES,
		'pointerup',
		'pointercancel',
		'mousedown',
		'mouseup',
		'touchend',
		'touchcancel',
		'click',
		'keyup',
	];
	const TAP_OVER = ['pointerup', 'pointercancel', 'touchend', 'touchcancel', 'click', 'keyup'];
	/** A tap whose end never arrives (the pointer left the window) lets go after this long. */
	const TAP_LIMIT_MS = 5000;
	/** The click that follows the end of a touch arrives within this time. */
	const TAP_TAIL_MS = 400;

	function endTap() {
		clearTimeout(tapEnd);
		tapEnd = undefined;
		tapping = false;
		evaluate();
	}

	function input(event: Event) {
		const now = Date.now();
		const moving = event.type === 'wheel' || event.type === 'pointermove';
		if (!tapping && !dark) {
			// In use: any touch, click or key keeps the device awake, the wheel and a moving mouse too
			// (counted once a second).
			if (moving) {
				if (now - lastUse < 1000) return;
				lastUse = now;
			}
			awake = wokenAt(now);
			return;
		}
		// A wheel or a mouse that moves does not wake a black screen.
		if (moving) return;
		// Black, or the tap that woke it is still going on: nothing under it hears of this.
		event.stopPropagation();
		if (event.cancelable && !event.type.startsWith('touch')) event.preventDefault();
		if (!tapping && WAKES.includes(event.type)) {
			tapping = true;
			awake = wokenAt(now);
			clearTimeout(tapEnd);
			tapEnd = setTimeout(endTap, TAP_LIMIT_MS);
		}
		if (tapping && TAP_OVER.includes(event.type)) {
			clearTimeout(tapEnd);
			tapEnd = setTimeout(endTap, TAP_TAIL_MS);
		}
	}

	$effect(() => {
		const options = { capture: true, passive: false };
		for (const name of TAP)
			window.addEventListener(
				name,
				input,
				name.startsWith('touch') ? { capture: true, passive: true } : options,
			);
		for (const name of ['wheel', 'pointermove'])
			window.addEventListener(name, input, { capture: true, passive: true });
		return () => {
			for (const name of TAP) window.removeEventListener(name, input, { capture: true });
			for (const name of ['wheel', 'pointermove'])
				window.removeEventListener(name, input, { capture: true });
		};
	});

	const label = $derived(
		hours
			? t('sleep_cover_label', {
					time: formatTime(wakesAt(Date.now(), timeZone, hours), timeZone, locale, hourCycle),
				})
			: '',
	);

	/** The browser's modal layer, so nothing open (a dialog, a panel) can show through. */
	function modal(node: HTMLDialogElement) {
		node.showModal();
		return {
			destroy() {
				if (node.open) node.close();
			},
		};
	}
</script>

{#if dark}
	<dialog
		use:modal
		aria-label={label}
		oncancel={(event) => event.preventDefault()}
		class="bg-screen-off fixed inset-0 m-0 h-full max-h-none w-full max-w-none cursor-none border-0 p-0 outline-none"
	></dialog>
{/if}
