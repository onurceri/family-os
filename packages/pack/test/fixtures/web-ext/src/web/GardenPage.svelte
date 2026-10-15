<script lang="ts">
	import { Button } from '@famos/ui/button';
	import { greeting } from './greeting.js';

	let count = $state(0);
</script>

<section class="garden grid gap-7 md:grid-cols-3">
	<p class="text-ink-soft">{greeting('Deniz')}</p>
	<Button onclick={() => count++}>{count}</Button>
</section>

<style>
	.garden {
		outline: 1px dashed currentColor;
	}
</style>
