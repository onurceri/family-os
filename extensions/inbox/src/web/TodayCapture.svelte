<script lang="ts">
	import { openPath } from '@famos/ui/famos';
	import type { InboxItem } from '../contract/index.js';
	import CaptureBox from './CaptureBox.svelte';
	import NoAiNote from './NoAiNote.svelte';

	/**
	 * Today, for a family that has just started: the capture box, the fastest way in, and what to
	 * do instead while no AI can read. After sending, the person follows the capture on the Quick
	 * add page.
	 */
	function sent(_item: InboxItem) {
		openPath('/add');
	}
</script>

<div class="grid gap-3">
	<CaptureBox onsent={sent} id="quick-add-text-today" />
	<NoAiNote />
</div>
