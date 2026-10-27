export {
	type ChannelSource,
	colorChannelsOf,
	colorMixFallback,
	type ResolveChannels,
	resolveByConvention,
} from './color-fallback.ts';
export {
	type ColorFallbackOptions,
	colorFallbackPlugin,
	writeColorFallbacks,
} from './color-writer.ts';
export { componentStylesPreprocessor, lowerToTargets } from './component-styles.ts';
export { PACKAGE_FILE, PACKAGE_FORMAT } from './format.ts';
export {
	type BuildOptions,
	type BuildResult,
	buildExtension,
	hashFiles,
	leftToHost,
	type PackageDescription,
} from './package.ts';
export { checkPlatform, currentPlatform, type Platform, type PlatformCheck } from './platform.ts';
export { SHARED_SERVER, SHARED_WEB } from './shared.ts';
export { buildStyles, LAYER_ORDER, PACKAGE_LAYER, STYLES_INPUT } from './styles.ts';
export { BROWSER_TARGETS, needsColorMixFallback } from './targets.ts';
export {
	chunkName,
	SHARED_MODULES_FILE,
	type SharedModulesOptions,
	sharedModules,
	TRIM_WEB,
	type Trim,
	trimmedModule,
} from './vite.ts';
export { buildWeb, WEB_ENTRY, WEB_STYLES } from './web.ts';
