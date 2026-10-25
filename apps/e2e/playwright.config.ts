import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the production bundle (`pnpm build`). Each test starts its own
 * server on a fresh data directory, with a fake OpenAI-compatible model (support/).
 */
export default defineConfig({
	testDir: './tests',
	fullyParallel: true,
	workers: process.env.CI ? 2 : 4,
	forbidOnly: Boolean(process.env.CI),
	retries: 0,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
	timeout: 60_000,
	globalSetup: './support/global-setup.ts',
	globalTeardown: './support/global-teardown.ts',
	use: {
		trace: 'retain-on-failure',
		// A phone first: FamilyOS must work at ~400px (AGENTS.md).
		...devices['Pixel 7'],
	},
});
