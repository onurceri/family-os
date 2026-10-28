/**
 * The oldest browsers FamilyOS builds for. Wall displays are often old Android photo frames and
 * fridge browsers whose system WebView is Chrome 106, so the bundle's syntax and the minified CSS
 * (which would otherwise drop fallback declarations written for older engines) stay at that floor.
 */
export const BROWSER_TARGETS = ['chrome106', 'edge106', 'firefox114', 'safari16.4', 'ios16.4'];

/** The first version of each browser with `color-mix()`. */
const COLOR_MIX_SINCE: Record<string, readonly [number, number]> = {
	chrome: [111, 0],
	edge: [111, 0],
	firefox: [113, 0],
	safari: [16, 2],
	ios: [16, 2],
};

/** `chrome106` → `['chrome', [106, 0]]`; null for a target that names no version. */
function parseTarget(target: string): [string, [number, number]] | null {
	const match = /^([a-z]+)(\d+)(?:\.(\d+))?/.exec(target);
	if (!match) return null;
	return [match[1] as string, [Number(match[2]), Number(match[3] ?? 0)]];
}

/**
 * Whether a target list includes a browser without `color-mix()`: then the build writes a
 * channel fallback before each mix and the theme stylesheets carry color channels. Raising the
 * floor past those browsers turns all of it off.
 */
export function needsColorMixFallback(targets: readonly string[] = BROWSER_TARGETS): boolean {
	return targets.some((target) => {
		const parsed = parseTarget(target);
		const since = parsed && COLOR_MIX_SINCE[parsed[0]];
		if (!parsed || !since) return false;
		const [major, minor] = parsed[1];
		return major < since[0] || (major === since[0] && minor < since[1]);
	});
}

/** The targets in lightningcss's form (`chrome106` → `{ chrome: 106 << 16 }`). */
export function lightningTargets(targets: readonly string[] = BROWSER_TARGETS): {
	[browser: string]: number;
} {
	const out: { [browser: string]: number } = {};
	for (const target of targets) {
		const parsed = parseTarget(target);
		if (!parsed) continue;
		const [browser, [major, minor]] = parsed;
		const name = browser === 'ios' ? 'ios_saf' : browser;
		out[name] = (major << 16) | (minor << 8);
	}
	return out;
}
