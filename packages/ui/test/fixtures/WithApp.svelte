<script lang="ts">
	import type { Component } from 'svelte';
	import { type AppContext, provideAppContext } from '../../src/app-context.js';

	/** Renders `component` inside the app context a test gives, as the app does for extensions. */
	let {
		app,
		component: Inner,
		props = {},
	}: {
		app: AppContext;
		// biome-ignore lint/suspicious/noExplicitAny: the component under test has props of its own.
		component: Component<any>;
		props?: Record<string, unknown>;
	} = $props();
	// svelte-ignore state_referenced_locally
	provideAppContext(app);
</script>

<Inner {...props} />
