import { defineProject } from 'vitest/config';
import { testDefaults } from '../../vitest.shared.ts';

export default defineProject({
	test: { ...testDefaults, name: 'kitchen', include: ['test/**/*.test.ts'] },
});
