import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS script without type declarations
import { classify, KEYS } from './ci-changes.mjs';

const on = (...keys: string[]) =>
	Object.fromEntries(KEYS.map((k: string) => [k, keys.includes(k)]));
const all = on(...KEYS);
const none = on();
const source = on('lint', 'typecheck', 'test', 'e2e', 'codeql');

describe('which CI jobs a change needs', () => {
	it('runs nothing for pictures and other binary docs media', () => {
		expect(classify(['docs/images/today.webp', 'docs/guide/pic.png'])).toEqual(none);
	});

	it('runs only the unit tests for docs, markdown, the licence and issue templates', () => {
		for (const path of [
			'docs/architecture.md',
			'README.md',
			'AGENTS.md',
			'CHANGELOG.md',
			'extensions/lists/README.md',
			'LICENSE',
			'.github/ISSUE_TEMPLATE/bug.yml',
			'.github/pull_request_template.md',
		]) {
			expect(classify([path]), path).toEqual(on('test'));
		}
	});

	it('runs everything when CI itself changes', () => {
		expect(classify(['.github/workflows/ci.yml'])).toEqual(all);
		expect(classify(['.github/actions/setup/action.yml'])).toEqual(all);
	});

	it('runs no e2e and no image build for unit-test-only files', () => {
		for (const path of [
			'packages/core/test/harness.ts',
			'extensions/lists/test/actions.test.ts',
			'scripts/ci-changes.test.ts',
			'apps/web/vitest.config.ts',
		]) {
			expect(classify([path]), path).toEqual(on('lint', 'typecheck', 'test', 'codeql'));
		}
	});

	it('runs lint, typecheck and e2e for the e2e suite', () => {
		expect(classify(['apps/e2e/tests/setup.spec.ts'])).toEqual(
			on('lint', 'typecheck', 'e2e', 'codeql'),
		);
	});

	it('builds the image and runs everything else for packaging', () => {
		for (const path of ['docker/Dockerfile', '.dockerignore', 'extensions.json', '.nvmrc']) {
			expect(classify([path]), path).toEqual(
				on('lint', 'typecheck', 'test', 'e2e', 'docker', 'codeql'),
			);
		}
	});

	it('audits only when a dependency changes', () => {
		for (const path of [
			'pnpm-lock.yaml',
			'pnpm-workspace.yaml',
			'package.json',
			'apps/web/package.json',
		]) {
			expect(classify([path]), path).toEqual(
				on('lint', 'typecheck', 'test', 'e2e', 'docker', 'audit', 'codeql'),
			);
		}
		expect(classify(['apps/web/src/app.ts']).audit).toBe(false);
	});

	it('runs lint, typecheck, test and e2e, but no image build, for source', () => {
		for (const path of [
			'apps/server/src/main.ts',
			'extensions/lists/src/web/Page.svelte',
			'languages/tr/app.json',
			'themes/coast/tokens.json',
			'scripts/release.mjs',
			'biome.json',
		]) {
			expect(classify([path]), path).toEqual(source);
		}
	});

	it('takes the union over a mixed list', () => {
		expect(classify(['README.md', 'apps/server/src/main.ts'])).toEqual(source);
		expect(classify(['docs/images/a.webp', 'README.md'])).toEqual(on('test'));
		expect(classify(['README.md', 'packages/core/test/a.test.ts'])).toEqual(
			on('lint', 'typecheck', 'test', 'codeql'),
		);
	});

	it('runs everything for an empty list, so a failed diff never skips a check', () => {
		expect(classify([])).toEqual(all);
		expect(classify(['', '  '])).toEqual(all);
	});

	it('treats an unknown path as source', () => {
		expect(classify(['something/new.xyz'])).toEqual(source);
	});

	it('runs nothing for the release commit, whatever it touched', () => {
		expect(classify(['package.json', 'CHANGELOG.md'], { release: true })).toEqual(none);
		expect(classify([], { release: true })).toEqual(none);
	});

	it('keeps the image build on main even for docs', () => {
		expect(classify(['README.md'], { dockerOnMain: true })).toEqual(on('test', 'docker'));
	});
});
