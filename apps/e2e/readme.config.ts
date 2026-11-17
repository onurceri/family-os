import { defineConfig, devices } from '@playwright/test';

/**
 * The day every picture shows: a Monday, 15:20 in the family's zone (Istanbul, UTC+3). The test
 * process, the browser and the server all read it (support/today.ts, support/fixed-clock-preload.ts),
 * so the pictures change only when the UI does. `FAMOS_E2E_FIXED_NOW` replaces it, for a check on another day.
 */
process.env.FAMOS_E2E_FIXED_NOW ??= '2026-11-16T15:20:00+03:00';

/**
 * The pictures of the README (`pnpm sweep:readme`): the same servers and prepared family as the
 * design sweep, one spec (sweep/readme.spec.ts). Not a test and not part of `pnpm e2e`.
 */
export default defineConfig({
	testDir: './sweep',
	testMatch: /readme(-agent-server)?\.spec\.ts/,
	reporter: 'list',
	timeout: 300_000,
	globalSetup: './support/sweep-setup.ts',
	globalTeardown: './support/global-teardown.ts',
	use: { ...devices['Pixel 7'] },
});
