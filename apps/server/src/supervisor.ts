import { constants } from 'node:os';

/**
 * The exit code with which the server asks to be started again: an extension was installed or
 * uninstalled, someone pressed Restart, or an optional package failed and was recorded so the
 * next start leaves it out. 75 is `EX_TEMPFAIL`: try again.
 */
export const RESTART_EXIT_CODE = 75;

/** A started server process, as far as the supervisor needs it. */
export interface SupervisedChild {
	once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
	kill(signal: NodeJS.Signals): void;
}

export interface SupervisorDeps {
	/** Starts the server (`main.mjs serve`). */
	start(): SupervisedChild;
	now(): number;
	/** Waits `ms`; `until` resolves early when the supervisor is told to stop. */
	wait(ms: number, until: Promise<void>): Promise<void>;
	/** Calls `handler` when the supervisor itself gets SIGTERM or SIGINT. */
	onSignal(handler: (signal: NodeJS.Signals) => void): void;
	log(message: string): void;
}

/** A start that ends within this time and asks to start again counts as quick. */
const QUICK_MS = 10_000;
const FIRST_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

/**
 * Runs the server and starts it again whenever it exits asking for that; any other exit is the
 * supervisor's own (so Docker's restart policy sees what the server said). Signals are passed on,
 * and after one the server is not started again. Starts that keep ending quickly wait longer and
 * longer in between, so a server that cannot stay up never spins.
 */
export async function supervise(deps: SupervisorDeps): Promise<number> {
	let child: SupervisedChild | undefined;
	let stopSignal: NodeJS.Signals | undefined;
	let stopped!: () => void;
	const stopping = new Promise<void>((resolve) => {
		stopped = resolve;
	});
	deps.onSignal((signal) => {
		stopSignal = signal;
		child?.kill(signal);
		stopped();
	});
	let delay = 0;
	for (;;) {
		const startedAt = deps.now();
		const running = deps.start();
		child = running;
		const { code, signal } = await new Promise<{
			code: number | null;
			signal: NodeJS.Signals | null;
		}>((resolve) => running.once('exit', (code, signal) => resolve({ code, signal })));
		child = undefined;
		const exitCode = code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1);
		if (stopSignal || code !== RESTART_EXIT_CODE) return exitCode;
		delay =
			deps.now() - startedAt < QUICK_MS
				? delay === 0
					? FIRST_DELAY_MS
					: Math.min(delay * 2, MAX_DELAY_MS)
				: 0;
		if (delay > 0) {
			deps.log(`FamilyOS restarts in ${delay / 1000} s`);
			await deps.wait(delay, stopping);
			if (stopSignal) return 0;
		} else deps.log('FamilyOS restarts');
	}
}
