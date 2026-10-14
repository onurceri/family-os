import type { WebExtension } from '@famos/ui/slots';
import { appDraftPresenters, appSlotContributions } from './app-slots.js';
import { type Contributions, collect } from './contributions.js';

/**
 * The one place extensions register their web side (`registerWebExtension`), and the one place
 * the app reads what they contribute (`contributions`). Reactive: whatever reads it follows when
 * an extension registers later.
 */
class Registry {
	#extensions = $state.raw<readonly WebExtension[]>([]);
	readonly #all = $derived<Contributions>(
		collect(this.#extensions, { slots: appSlotContributions, presenters: appDraftPresenters }),
	);

	register(ext: WebExtension) {
		this.#extensions = [...this.#extensions, ext];
	}

	get extensions() {
		return this.#all.extensions;
	}
	/** An extension's web entry by its id. */
	extension(id: string): WebExtension | undefined {
		return this.#all.extensions.find((e) => e.id === id);
	}
	get slots() {
		return this.#all.slots;
	}
	get nav() {
		return this.#all.nav;
	}
	get presenters() {
		return this.#all.presenters;
	}
	get pages() {
		return this.#all.pages;
	}
	get timelines() {
		return this.#all.timelines;
	}
	get facets() {
		return this.#all.facets;
	}
	get blocks() {
		return this.#all.blocks;
	}
	get share() {
		return this.#all.share;
	}
}

export const contributions = new Registry();

/** Adds an extension's `./web` entry to the app. */
export function registerWebExtension(ext: WebExtension): void {
	contributions.register(ext);
}
