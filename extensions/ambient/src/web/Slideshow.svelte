<script lang="ts">
	import { fade } from 'svelte/transition';
	import { photoUrl } from './data.js';

	/**
	 * The family's photos, one after the other with a crossfade, filling its box. It shows the
	 * next photo that loads, fetches the one after it in advance and skips photos that fail.
	 * `shown` is the photo on screen (null while there is none), so the caller can lay its text
	 * out for a photo or for none.
	 */
	let {
		ids,
		seconds,
		running,
		shown = $bindable(null),
	}: {
		ids: readonly string[];
		seconds: number;
		running: boolean;
		shown?: string | null;
	} = $props();

	let position = 0;
	let failures = 0;

	const reducedMotion = () =>
		typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
	const fadeMs = $derived(reducedMotion() ? 0 : 1500);

	function load(url: string): Promise<boolean> {
		return new Promise((resolve) => {
			const image = new Image();
			image.onload = () => resolve(true);
			image.onerror = () => resolve(false);
			image.src = url;
		});
	}

	$effect(() => {
		const list = ids;
		if (!running || list.length === 0) {
			shown = null;
			return;
		}
		let cancelled = false;
		failures = 0;

		async function advance() {
			while (!cancelled && failures < list.length) {
				const url = photoUrl(list[position % list.length] as string);
				position++;
				if (await load(url)) {
					if (cancelled) return;
					shown = url;
					failures = 0;
					// Preload the next one so the crossfade never waits for the network.
					void load(photoUrl(list[position % list.length] as string));
					return;
				}
				failures++;
			}
		}
		void advance();
		const slide = setInterval(() => void advance(), seconds * 1000);
		return () => {
			cancelled = true;
			clearInterval(slide);
		};
	});
</script>

{#if shown}
	{#key shown}
		<img
			src={shown}
			alt=""
			class="absolute inset-0 size-full object-cover"
			transition:fade={{ duration: fadeMs }}
		/>
	{/key}
{/if}
