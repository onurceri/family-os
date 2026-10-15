import { defineProject } from 'vitest/config';
import { testDefaults } from '../../vitest.shared.ts';

export default defineProject({
	test: { ...testDefaults, name: 'pets', include: ['test/**/*.test.ts'] },
});
