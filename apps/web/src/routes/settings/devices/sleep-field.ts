/** What the sleep switch starts with when it is first turned on. */
export const DEFAULT_FROM = '22:00';
export const DEFAULT_UNTIL = '07:00';

export type SleepChoice = { on: boolean; from: string; until: string };
type Saved = { from: string; until: string } | null | undefined;

/** The same two times cannot make a window. */
export function sleepProblem(choice: SleepChoice): boolean {
	return choice.on && choice.from === choice.until;
}

/** What is sent: the hours when the switch is on and both times are filled in, else null (never sleeps). */
export function sleepToSave(choice: SleepChoice): { from: string; until: string } | null {
	if (!choice.on || !choice.from || !choice.until) return null;
	return { from: choice.from, until: choice.until };
}

/** The switch and times as a saved window shows them (off keeps the default times). */
export function sleepChoiceOf(saved: Saved): SleepChoice {
	return saved
		? { on: true, from: saved.from, until: saved.until }
		: { on: false, from: DEFAULT_FROM, until: DEFAULT_UNTIL };
}

/** Whether the choice differs from what is saved. */
export function sleepChanged(choice: SleepChoice, saved: Saved): boolean {
	const now = sleepToSave(choice);
	if (!now || !saved) return (now === null) !== (saved === null || saved === undefined);
	return now.from !== saved.from || now.until !== saved.until;
}
