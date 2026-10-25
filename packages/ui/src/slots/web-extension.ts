import type { Component } from 'svelte';
import type { AnyDraftPresenter } from './drafts.ts';
import type { NavContribution } from './nav.ts';
import type { SlotContribution } from './slot-props.ts';
import type { TimelineContribution, TodayBlockContribution, TodayFacet } from './today.ts';

/** What an extension's `./web` entry exports. */
/** A model-backed feature that can be switched off on its own (Settings → AI). */
export interface AiFeatureContribution {
	/** The `feature` the extension names in model calls, e.g. `inbox.extract`. */
	id: string;
	labelKey: string;
	hintKey?: string;
}

/** Translatable texts: keys to strings, nested as in the JSON catalog files. */
export interface WebMessages {
	readonly [key: string]: string | WebMessages;
}

export interface WebExtension {
	/** The manifest's id: the namespace of its contributions and of its texts. */
	id: string;
	/**
	 * Its English texts (`src/messages/en.json`), registered under its id so keys read
	 * `<id>:<key>`. Other languages come from the server with the language's pack.
	 */
	messages?: WebMessages;
	/** Name and one-line description in Settings → Features (`<extension>:<key>`). */
	labelKey?: string;
	descriptionKey?: string;
	aiFeatures?: AiFeatureContribution[];
	slots?: SlotContribution[];
	/** Things that belong on the day's timeline on Today. */
	timeline?: TimelineContribution[];
	/** What Today shows in shapes of its own (counts per person, the photo, the weather, first steps). */
	today?: TodayFacet[];
	/** Blocks of Today this extension adds to "What Today shows". */
	blocks?: TodayBlockContribution[];
	nav?: NavContribution[];
	drafts?: AnyDraftPresenter[];
	/** Pages served under their path (matched by the app's catch-all route). */
	pages?: PageContribution[];
	/**
	 * Routes of its own API (paths under `/api/v1/<id>`, a `:name` segment matches one segment)
	 * whose last answer the app keeps for offline use: the reads a family wants when the network
	 * is gone (today's events, the shopping list). Only plain reads with nothing private to a
	 * single device; the copy is dropped on sign-out.
	 */
	offlineReads?: string[];
}

/** What the app passes to a page component: the values of the `:name` segments of its path. */
export interface PageProps {
	params: Record<string, string>;
}

export interface PageContribution {
	/** Unique, namespaced: `<extension>.<name>`. */
	id: string;
	/**
	 * Path under the SPA, e.g. `/calendar`. A segment written `:name` matches any single segment
	 * (`/vehicles/:id`) and arrives in the component's `params`. Exact paths win over patterns.
	 */
	path: string;
	/**
	 * The capability needed to open the page, as on its navigation entry (the same one: a page
	 * and its entry on one path, or a record page under its list's entry, ask for the same). Without
	 * it the app shows a calm "this page is for people who may use …" in place of the page and
	 * never loads it, so a typed address, a bookmark or a shared link opens no page of refused
	 * reads. The server still checks every read and action; this is what the person sees.
	 */
	requires?: string;
	/** A page without parameters may take no props at all. */
	component: () => Promise<{ default: Component | Component<PageProps> }>;
}

/**
 * An extension's `./web` entry. `manifest` is the `famos` field of its package.json, the same one
 * its server side declares, so both sides share one id.
 */
export function defineWebExtension(
	definition: Omit<WebExtension, 'id'> & { manifest: { id: string } },
): WebExtension {
	const { manifest, ...rest } = definition;
	const ext: WebExtension = { ...rest, id: manifest.id };
	const own = (id: string) => id.startsWith(`${ext.id}.`);
	for (const d of ext.drafts ?? []) {
		if (!own(d.actionId))
			throw new Error(`Draft presenter "${d.actionId}" must be namespaced as "${ext.id}.…"`);
	}
	for (const c of [
		...(ext.slots ?? []),
		...(ext.timeline ?? []),
		...(ext.today ?? []),
		...(ext.nav ?? []),
		...(ext.nav ?? []).flatMap((n) => n.children ?? []),
		...(ext.pages ?? []),
	]) {
		if (!own(c.id)) throw new Error(`Contribution "${c.id}" must be namespaced as "${ext.id}.…"`);
	}
	const blocks = new Set((ext.blocks ?? []).map((b) => b.id));
	for (const id of blocks) {
		if (id !== ext.id && !own(id))
			throw new Error(`Block "${id}" must be "${ext.id}" or namespaced as "${ext.id}.…"`);
	}
	for (const c of [...(ext.slots ?? []), ...(ext.today ?? [])]) {
		const block = 'block' in c ? c.block : undefined;
		if (block !== undefined && !blocks.has(block))
			throw new Error(`"${c.id}" names the block "${block}", which "${ext.id}" does not add`);
	}
	return ext;
}
