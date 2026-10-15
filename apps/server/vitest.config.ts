import { defineProject } from 'vitest/config';
import { testDefaults } from '../../vitest.shared.ts';

export default defineProject({
	test: {
		...testDefaults,
		name: 'server',
		include: ['test/**/*.test.ts'],
		// Tests here boot a whole runtime (migrations, workers, local servers); on a busy machine a
		// correct run can take several times longer than usual, so the limit is a backstop against hangs only.
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
