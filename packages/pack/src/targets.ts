/**
 * The oldest browsers FamilyOS builds for. Wall displays are often old Android photo frames and
 * fridge browsers whose system WebView is Chrome 106, so the bundle's syntax and the minified CSS
 * (which would otherwise drop fallback declarations written for older engines) stay at that floor.
 */
export const BROWSER_TARGETS = ['chrome106', 'edge106', 'firefox114', 'safari16.4', 'ios16.4'];
