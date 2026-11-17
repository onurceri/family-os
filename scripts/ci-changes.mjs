// Decides which CI jobs a change can affect, from the paths it touches.
//   git diff --name-only A B | node scripts/ci-changes.mjs [--release] [--docker-on-main]
//   node scripts/ci-changes.mjs --files path/a path/b
// Prints `key=true|false` lines for $GITHUB_OUTPUT. It fails open: an empty or unknown list runs
// everything, so a diff that could not be made never skips a check.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const KEYS = ['lint', 'typecheck', 'test', 'e2e', 'docker', 'audit', 'codeql'];

const flags = (on) => Object.fromEntries(KEYS.map((k) => [k, on.includes(k)]));
const NOTHING = flags([]);
const EVERYTHING = flags(KEYS);
// Unit tests read docs (public-api, themes, readme pictures), so a doc edit still runs them.
const DOCS = flags(['test']);
const TESTS = flags(['lint', 'typecheck', 'test', 'codeql']);
const E2E = flags(['lint', 'typecheck', 'e2e', 'codeql']);
// Source runs everything but the image build, which only packaging can break.
const SOURCE = flags(['lint', 'typecheck', 'test', 'e2e', 'codeql']);
// Packaging also builds the image; only a dependency change needs the audit.
const PACKAGING = flags(['lint', 'typecheck', 'test', 'e2e', 'docker', 'codeql']);

const MEDIA = /\.(png|jpe?g|webp|gif|svg|ico|mp4|webm|mov|pdf)$/i;
const DEPENDENCIES = new Set(['pnpm-lock.yaml', 'pnpm-workspace.yaml']);
const PACKAGING_FILES = new Set(['.dockerignore', 'extensions.json', '.nvmrc']);

/** The jobs one path asks for; the first matching rule wins. */
export function classifyPath(path) {
	if (path.startsWith('docs/images/') || (path.startsWith('docs/') && MEDIA.test(path))) {
		return NOTHING;
	}
	if (path.startsWith('.github/workflows/') || path.startsWith('.github/actions/')) {
		return EVERYTHING;
	}
	if (DEPENDENCIES.has(path) || path === 'package.json' || path.endsWith('/package.json')) {
		return { ...PACKAGING, audit: true };
	}
	if (path.startsWith('docker/') || PACKAGING_FILES.has(path)) return PACKAGING;
	if (path.startsWith('apps/e2e/')) return E2E;
	if (
		/(^|\/)test\//.test(path) ||
		/\.test\.ts$/.test(path) ||
		/(^|\/)vitest\.config\.ts$/.test(path)
	) {
		return TESTS;
	}
	if (
		path.startsWith('docs/') ||
		path.endsWith('.md') ||
		path === 'LICENSE' ||
		path.startsWith('.github/ISSUE_TEMPLATE/')
	) {
		return DOCS;
	}
	return SOURCE;
}

/**
 * The jobs a list of changed paths needs. `release` is the release commit, which the Release
 * workflow checks itself; `dockerOnMain` keeps the image build running on main (a warm layer cache).
 */
export function classify(paths, { release = false, dockerOnMain = false } = {}) {
	if (release) return { ...NOTHING };
	const list = paths.map((p) => p.trim()).filter(Boolean);
	const result = list.length === 0 ? { ...EVERYTHING } : { ...NOTHING };
	for (const path of list) {
		const need = classifyPath(path);
		for (const key of KEYS) result[key] ||= need[key];
	}
	if (dockerOnMain) result.docker = true;
	return result;
}

function main(argv) {
	const at = argv.indexOf('--files');
	const options = {
		release: argv.includes('--release'),
		dockerOnMain: argv.includes('--docker-on-main'),
	};
	const paths =
		at >= 0
			? argv.slice(at + 1).filter((a) => !a.startsWith('--'))
			: readFileSync(0, 'utf8').split('\n');
	const result = classify(paths, options);
	for (const key of KEYS) console.log(`${key}=${result[key]}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2));
}
