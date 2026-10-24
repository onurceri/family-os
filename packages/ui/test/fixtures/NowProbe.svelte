<script lang="ts">
	import { useNow } from '../../src/now.svelte.js';

	const clock = useNow(30_000);
</script>

{clock.current}
