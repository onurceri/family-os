/** The question "discard the waiting changes?" shown while signing out; answered by the layout's dialog. */
class SignOutConfirm {
	count = $state<number | null>(null);
	#answer: ((discard: boolean) => void) | null = null;

	ask(count: number): Promise<boolean> {
		this.#answer?.(false);
		this.count = count;
		return new Promise((resolve) => {
			this.#answer = resolve;
		});
	}

	answer(discard: boolean) {
		this.count = null;
		this.#answer?.(discard);
		this.#answer = null;
	}
}

export const signOutConfirm = new SignOutConfirm();
