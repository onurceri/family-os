import type { ActionAccess } from '@famos/ui/app';
import { type AccessDecision, accessOf, inputKey } from './access.js';

/** Where the answers come from; the tests give their own. */
export interface AccessSource {
	all(): Promise<Record<string, AccessDecision>>;
	check(actionId: string, input: unknown): Promise<AccessDecision | null>;
}

/**
 * How readers learn that an answer changed: `read` is called wherever an answer is read, `bump`
 * whenever one changes. The app backs them with reactive state; the tests need none.
 */
export interface ChangeSignal {
	read(): void;
	bump(): void;
}

/** A form asks while its fields change: the last ask waits this long, the ones before it never go. */
const CHECK_DELAY_MS = 250;
/** An exact answer may turn on whose thing it is, which can change without any event reaching here. */
const EXACT_TTL_MS = 15_000;

/**
 * What the signed-in member may do with each action, from the server's own decision, so a control
 * and the action runner never disagree. The static answer for every action is read once with the
 * session and again whenever it can change (a role, a member, an extension, a refusal); the exact
 * answer for an input, where the static one `depends`, is asked for when a form needs it.
 */
export class AccessBook {
	#all: Record<string, AccessDecision> = {};
	#exact = new Map<string, { decision: AccessDecision | null; at: number }>();
	#timers = new Map<string, ReturnType<typeof setTimeout>>();
	#asked = new Map<string, number>();
	#source: AccessSource;
	#signal: ChangeSignal;
	#now: () => number;
	#delay: number;

	constructor(
		source: AccessSource,
		signal: ChangeSignal = { read() {}, bump() {} },
		now = () => Date.now(),
		delay = CHECK_DELAY_MS,
	) {
		this.#source = source;
		this.#signal = signal;
		this.#now = now;
		this.#delay = delay;
	}

	/** Reads every static answer. A failed read keeps the answers known so far. */
	async load(): Promise<void> {
		try {
			this.#all = await this.#source.all();
		} catch {
			// Not signed in or not reachable: the answers known so far stay.
			return;
		}
		this.#exact.clear();
		this.#signal.bump();
	}

	/** Nobody is signed in: nothing is offered. */
	clear(): void {
		this.#all = {};
		this.#exact.clear();
		for (const timer of this.#timers.values()) clearTimeout(timer);
		this.#timers.clear();
		this.#signal.bump();
	}

	/** The answer for any input. Reactive. */
	access(actionId: string): ActionAccess {
		this.#signal.read();
		return accessOf(this.#all[actionId]);
	}

	/**
	 * The answer for this input: the static one where it does not depend on the input, else the
	 * exact one once the server has given it (the static one until then). Reactive.
	 */
	accessFor(actionId: string, input: unknown): ActionAccess {
		this.#signal.read();
		const general = accessOf(this.#all[actionId]);
		if (general !== 'depends') return general;
		const key = inputKey(actionId, input);
		const known = this.#exact.get(key);
		if (known && this.#now() - known.at < EXACT_TTL_MS) {
			return known.decision ? accessOf(known.decision, true) : general;
		}
		this.#ask(actionId, key, input);
		return general;
	}

	/** Asks for the last input given for an action once its form has stopped changing. */
	#ask(actionId: string, key: string, input: unknown): void {
		if (this.#asked.has(key)) return;
		clearTimeout(this.#timers.get(actionId));
		this.#timers.set(
			actionId,
			setTimeout(() => {
				this.#timers.delete(actionId);
				this.#asked.set(key, this.#now());
				void this.#source
					.check(actionId, input)
					.catch(() => null)
					.then((decision) => {
						this.#asked.delete(key);
						this.#exact.set(key, { decision, at: this.#now() });
						this.#signal.bump();
					});
			}, this.#delay),
		);
	}
}
