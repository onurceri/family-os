import { type paths, unwrap } from '@famos/api-client';
import { DEFAULT_STYLE, isStyleId, type StyleId } from '@famos/ui/styles';
import { api } from './api';

/**
 * Themes. The built-in Ev Işığı tokens come with the app's own stylesheet (first
 * paint, offline); the server's generated stylesheet of the active theme is applied on top as a
 * `<style>` element. The last one is kept on this device and applied by the inline script in
 * `app.html` before first paint, so a themed app never flashes the default.
 */
export interface ThemeSwatches {
	wall: string;
	surface: string;
	ink: string;
	'ink-soft': string;
	attention: string;
	now: string;
	sun: string;
	info: string;
	heat: string;
	[token: string]: string;
}

type AppearanceResponse =
	paths['/api/v1/core/appearance']['get']['responses'][200]['content']['application/json'];

/**
 * The style ids of the registry (`STYLES` in `@famos/ui`) and of the API (core's `STYLE_IDS`)
 * must be the same list: this fails to compile when one side gains or loses a style.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const stylesAgree: Same<StyleId, AppearanceResponse['style']> = true;
void stylesAgree;

export interface Theme {
	id: string;
	name: string;
	version: string;
	authors: string[];
	source: 'bundled' | 'installed';
	overridesBundled: boolean;
	preview: { day: ThemeSwatches; night: ThemeSwatches };
	/** The style the pack suggests while the family has not chosen one. */
	style: StyleId | null;
	installedAt: number | null;
	url: string | null;
}

const STORAGE_KEY = 'famos.theme';
const ELEMENT_ID = 'famos-theme';
/** The last style this device used; `app.html` sets it before first paint. */
const STYLE_KEY = 'famos.style';

/** Sets the style on the document: its type ramp and fonts apply under `[data-style]`. */
function setStyleAttribute(id: StyleId) {
	if (document.documentElement.dataset.style !== id) document.documentElement.dataset.style = id;
}

function writeStoredStyle(id: StyleId) {
	try {
		localStorage.setItem(STYLE_KEY, id);
	} catch {
		// storage full or unavailable: the default style shows first next time
	}
}

interface Stored {
	id: string;
	version: string;
	css: string;
}

function readStored(): Stored | null {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? (JSON.parse(raw) as Stored) : null;
	} catch {
		return null;
	}
}

function writeStored(value: Stored | null) {
	try {
		if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
		else localStorage.removeItem(STORAGE_KEY);
	} catch {
		// storage full or unavailable: fetched again next time
	}
}

function setStyle(css: string | null) {
	let el = document.getElementById(ELEMENT_ID);
	if (css === null) {
		el?.remove();
		return;
	}
	if (!el) {
		el = document.createElement('style');
		el.id = ELEMENT_ID;
		document.head.append(el);
	}
	if (el.textContent !== css) el.textContent = css;
	// The browser chrome (status bar, task switcher) follows the wall color of the theme.
	requestAnimationFrame(() => {
		const wall = getComputedStyle(document.documentElement).getPropertyValue('--wall').trim();
		if (wall) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', wall);
	});
}

class Appearance {
	/** The themes the server offers; empty until loaded. */
	themes = $state<Theme[]>([]);
	/** The theme in use on this device. */
	current = $state<string | null>(null);
	/** The family's default theme. */
	family = $state<string | null>(null);
	/** This person's own choice; null follows the family. */
	mine = $state<string | null>(null);
	/**
	 * A theme tried on for a look, not saved: the whole app shows it until the preview ends (Use,
	 * Stop, sign-out or a reload). It is kept in memory only, so a reload shows the real choice.
	 */
	previewing = $state<string | null>(null);
	/** The theme is tried as the family's default (Family → Family look), not as this person's own. */
	previewingForFamily = $state(false);
	/** The style in use on this device. */
	style = $state<StyleId>(DEFAULT_STYLE);
	/** The family's chosen style; null when it never chose one (the theme's suggestion applies). */
	familyStyle = $state<StyleId | null>(null);
	/** This person's own style; null follows the family. */
	myStyle = $state<StyleId | null>(null);
	/** A style tried on for a look, not saved: like `previewing`, it lasts until the preview ends. */
	previewingStyle = $state<StyleId | null>(null);
	/** The blocks Today hides for this person: their own choice, else the family's. */
	hidden = $state<string[]>([]);
	/** The blocks the family's Today hides by default. */
	familyHidden = $state<string[]>([]);
	/** This person's own choice of what Today hides; null follows the family. */
	myHidden = $state<string[] | null>(null);
	/** The choices above have been read once (Today waits for them, so it composes once). */
	loaded = $state(false);

	async loadThemes(): Promise<void> {
		const res = await api.GET('/api/v1/core/themes');
		if (res.data) this.themes = res.data as Theme[];
	}

	/** Reads which theme applies to this caller and applies it. */
	async refresh(): Promise<void> {
		try {
			const res = await api.GET('/api/v1/core/appearance');
			if (!res.data) return;
			this.family = res.data.family;
			this.mine = res.data.mine;
			this.familyStyle = res.data.familyStyle;
			this.myStyle = res.data.myStyle;
			this.hidden = res.data.hidden;
			this.familyHidden = res.data.familyHidden;
			this.myHidden = res.data.myHidden;
			this.applyStyle(res.data.style);
			await this.apply(res.data.theme, res.data.version);
		} catch {
			// offline: what is applied stays
		} finally {
			this.loaded = true;
		}
	}

	/**
	 * Saves this person's own choice of what Today hides (null follows the family). Today follows
	 * at once; on failure it goes back and the error is the caller's to tell.
	 */
	async setMyHidden(hidden: string[] | null): Promise<void> {
		const before = { hidden: this.hidden, myHidden: this.myHidden };
		this.myHidden = hidden;
		this.hidden = hidden ?? this.familyHidden;
		try {
			unwrap(await api.POST('/api/v1/actions/core.setMyTodayBlocks', { body: { hidden } }));
		} catch (error) {
			this.hidden = before.hidden;
			this.myHidden = before.myHidden;
			throw error;
		}
	}

	/**
	 * Shows a theme everywhere without choosing it; `endPreview` goes back to the one in use.
	 * `forFamily` marks it as tried for the family's default (its page ends it when left).
	 */
	async preview(id: string, { forFamily = false }: { forFamily?: boolean } = {}): Promise<void> {
		this.previewing = id;
		this.previewingForFamily = forFamily;
		try {
			const res = await api.GET('/api/v1/core/themes/{id}/stylesheet.css', {
				params: { path: { id } },
				parseAs: 'text',
			});
			if (res.data === undefined) throw new Error('stylesheet unavailable');
			// Another preview (or its end) may have come first.
			if (this.previewing === id) setStyle(res.data);
		} catch {
			if (this.previewing === id) this.endPreview();
		}
	}

	endPreview(): void {
		if (this.previewing === null) return;
		this.previewing = null;
		this.previewingForFamily = false;
		const stored = readStored();
		setStyle(stored && stored.id === this.current ? stored.css : null);
	}

	/** Shows a style everywhere without choosing it; `endStylePreview` goes back to the one in use. */
	previewStyle(id: StyleId): void {
		this.previewingStyle = id;
		setStyleAttribute(id);
	}

	endStylePreview(): void {
		if (this.previewingStyle === null) return;
		this.previewingStyle = null;
		setStyleAttribute(this.style);
	}

	/** Ends whatever is being tried (sign-out, another person signing in). */
	endPreviews(): void {
		this.endStylePreview();
		this.endPreview();
	}

	/**
	 * Keeps what this person is trying as their own: the style, the theme (unless it is tried for
	 * the family) or both. Applying the saved choice ends the preview.
	 */
	async useTried(): Promise<void> {
		const style = this.previewingStyle;
		const theme = this.previewingForFamily ? null : this.previewing;
		if (style) unwrap(await api.POST('/api/v1/actions/core.setMyStyle', { body: { style } }));
		if (theme) unwrap(await api.POST('/api/v1/actions/core.setMyTheme', { body: { theme } }));
		await Promise.all([this.loadThemes(), this.refresh()]);
	}

	/** Applies the style in use and keeps it on this device for the next first paint. */
	applyStyle(id: string | null | undefined): void {
		const style = isStyleId(id) ? id : DEFAULT_STYLE;
		// Choosing the previewed style ends the preview; anything else waits until it ends.
		if (this.previewingStyle === style) this.previewingStyle = null;
		this.style = style;
		writeStoredStyle(style);
		if (this.previewingStyle === null) setStyleAttribute(style);
	}

	/** Applies a theme by id (`version` skips the download when this device already has it). */
	async apply(id: string | null, version: string | null = null): Promise<void> {
		// Choosing the previewed theme ends the preview; anything else waits until it ends.
		if (this.previewing !== null && this.previewing === id) {
			this.previewing = null;
			this.previewingForFamily = false;
		}
		const show = (css: string | null) => {
			if (this.previewing === null) setStyle(css);
		};
		if (!id) {
			show(null);
			writeStored(null);
			this.current = null;
			return;
		}
		const stored = readStored();
		if (stored && stored.id === id && (version === null || stored.version === version)) {
			show(stored.css);
			this.current = id;
			if (version !== null) return;
		}
		try {
			const res = await api.GET('/api/v1/core/themes/{id}/stylesheet.css', {
				params: { path: { id } },
				parseAs: 'text',
				// Revalidate with the ETag: a 304 costs almost nothing, a changed pack is fetched.
				cache: 'no-cache',
			});
			if (res.data === undefined) throw new Error('stylesheet unavailable');
			const etag = res.response.headers.get('etag')?.replaceAll('"', '') ?? version ?? '';
			show(res.data);
			writeStored({ id, version: etag, css: res.data });
			this.current = id;
		} catch {
			// Unreachable or gone: keep what is applied (or the built-in look).
		}
	}
}

export const appearance = new Appearance();
