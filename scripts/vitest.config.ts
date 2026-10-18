import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineProject } from 'vitest/config';
import { testDefaults } from '../vitest.shared.ts';

export default defineProject({
	// Loading an extension's web entry (draft-dates.test.ts) pulls in Svelte components; the icon
	// library's own components are replaced, since none of the text under test uses one.
	plugins: [svelte({ configFile: false })],
	resolve: {
		alias: { '@lucide/svelte': fileURLToPath(new URL('./icons-stub.ts', import.meta.url)) },
	},
	test: { ...testDefaults, name: 'scripts', include: ['*.test.ts'] },
});
