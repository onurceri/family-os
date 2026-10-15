import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'pack', include: ['test/**/*.test.ts'] } });
