<script lang="ts">
	import { initialOf } from './initial.js';
	import { onMemberColor } from './on-member-color.js';

	/**
	 * A family member: their color and initial, or their photo inside a ring of their color
	 * (the color is how the app marks whose thing something is). `size` in px. `photo`: the
	 * picture's address; when it does not load, the initial shows as without one. `anyone`: things
	 * for no one in particular get a neutral people icon on `idle`, never a letter (which would
	 * read as a member's initial).
	 */
	let {
		name,
		color,
		size = 36,
		anyone = false,
		photo = null,
		ring = true,
	}: {
		name: string;
		color: string;
		size?: number;
		anyone?: boolean;
		photo?: string | null | undefined;
		/** False where the avatar already stands inside a ring of the member's color. */
		ring?: boolean;
	} = $props();

	/** The address that failed to load, so a new photo is tried again. */
	let failed = $state<string | null>(null);
	const showPhoto = $derived(photo ? photo !== failed : false);
	const border = $derived(ring ? (size >= 24 ? 2 : 1) : 0);
</script>

{#if anyone}
	<span
		class="anyone bg-idle text-ink-soft inline-flex shrink-0 items-center justify-center rounded-full select-none"
		style:width="{size}px"
		style:height="{size}px"
		aria-hidden="true"
		data-testid="anyone-avatar"
		><svg
			viewBox="0 0 24 24"
			width={Math.round(size * 0.58)}
			height={Math.round(size * 0.58)}
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path
				d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14a6.5 6.5 0 0 1 3 6"
			/></svg
		></span
	>
{:else if showPhoto}
	<span
		class="photo inline-flex shrink-0 overflow-hidden rounded-full select-none"
		style:border="{border}px solid {color}"
		style:box-sizing="border-box"
		style:width="{size}px"
		style:height="{size}px"
		aria-hidden="true"
		data-testid="photo-avatar"
		><img
			src={photo}
			alt=""
			loading="lazy"
			decoding="async"
			draggable="false"
			class="h-full w-full rounded-full object-cover"
			onerror={() => (failed = photo ?? null)}
		/></span
	>
{:else}
	<span
		class="day inline-flex shrink-0 items-center justify-center rounded-full font-bold select-none"
		style:background-color={color}
		style:color={onMemberColor(color)}
		style:width="{size}px"
		style:height="{size}px"
		style:font-size="{Math.round(size * 0.42)}px"
		aria-hidden="true">{initialOf(name)}</span
	>
{/if}
