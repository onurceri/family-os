import { defineConfig, devices } from '@playwright/test';

/**
 * The family the old-browser comparison opens (`scripts/old-browser/compare/run.sh`): one spec
 * (old-browser/serve.spec.ts) that prepares the sample family and keeps its server running. Not a
 * test and not part of `pnpm e2e`.
 */
export default defineConfig({
	testDir: './old-browser',
	reporter: 'list',
	timeout: 3_600_000,
	globalSetup: './support/sweep-setup.ts',
	globalTeardown: './support/global-teardown.ts',
	use: { ...devices['Pixel 7'] },
});
