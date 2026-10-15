import { defineProject } from 'vitest/config';
import { testDefaults } from '../../vitest.shared.ts';

export default defineProject({
	test: { ...testDefaults, name: 'chores', include: ['test/**/*.test.ts'] },
});
