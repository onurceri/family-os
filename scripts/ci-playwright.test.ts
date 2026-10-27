import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CI runs the end-to-end tests inside the Playwright image, which carries one browser build. The
 * test runner only drives the build of its own version, so bumping @playwright/test without the
 * image (or the other way round) would fail every e2e job with a missing browser.
 */
const root = join(import.meta.dirname, '..');

describe('the CI Playwright image', () => {
	it('matches the @playwright/test version of apps/e2e', () => {
		const pkg = JSON.parse(readFileSync(join(root, 'apps/e2e/package.json'), 'utf8'));
		const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
		const image = /mcr\.microsoft\.com\/playwright:v([0-9.]+)-/.exec(workflow)?.[1];
		expect(
			image,
			'ci.yml should run e2e in mcr.microsoft.com/playwright:v<version>-…',
		).toBeDefined();
		expect(image).toBe(pkg.devDependencies['@playwright/test']);
	});
});
