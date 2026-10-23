import { defineConfig, devices } from '@playwright/test';

/**
 * The pictures of the README (`pnpm sweep:readme`): the same servers and prepared family as the
 * design sweep, one spec (sweep/readme.spec.ts). Not a test and not part of `pnpm e2e`.
 */
export default defineConfig({
	testDir: './sweep',
	testMatch: 'readme.spec.ts',
	reporter: 'list',
	timeout: 300_000,
	globalSetup: './support/sweep-setup.ts',
	globalTeardown: './support/global-teardown.ts',
	use: { ...devices['Pixel 7'] },
});
