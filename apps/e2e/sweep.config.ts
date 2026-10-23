import { defineConfig, devices } from '@playwright/test';

/**
 * The design sweep (`pnpm sweep`): screenshots of every page for a UI review, not a test and not
 * part of `pnpm e2e`. Same servers and prepared family as the suite (support/).
 */
export default defineConfig({
	testDir: './sweep',
	// The README's pictures have their own config (readme.config.ts).
	testIgnore: /readme(-agent-server)?\.spec\.ts/,
	fullyParallel: true,
	reporter: 'list',
	timeout: 1_200_000,
	globalSetup: './support/sweep-setup.ts',
	globalTeardown: './support/global-teardown.ts',
	use: { ...devices['Pixel 7'] },
});
