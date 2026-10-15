import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineProject } from 'vitest/config';

// Component tests mount Svelte 5 components in happy-dom (no testing-library): see test/helpers.ts.
export default defineProject({
	// No svelte.config.js: the components need no preprocessing, and the options are these.
	plugins: [svelte({ configFile: false })],
	resolve: { conditions: ['browser'] },
	test: { name: 'ui', include: ['test/**/*.test.ts'], environment: 'happy-dom' },
});
