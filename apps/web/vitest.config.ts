import { defineProject } from 'vitest/config';
import { testDefaults } from '../../vitest.shared.ts';

// Plain TypeScript modules of the app only (no Svelte, no browser): see src/lib/offline-queue.ts.
export default defineProject({
	test: { ...testDefaults, name: 'web', include: ['src/**/*.test.ts'] },
});
