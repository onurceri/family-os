<script lang="ts">
	import Pill from './Pill.svelte';

	/**
	 * The quiet mark in a page's head when the page's main action is not for this viewer: the page
	 * can be read and nothing on it can be changed. Said once, by the head, and not by a disabled
	 * control (principle 5). Both texts are already translated.
	 */
	let { label, hint }: { label: string; hint: string } = $props();
</script>

<span title={hint} data-testid="view-only"><Pill>{label}</Pill></span>
