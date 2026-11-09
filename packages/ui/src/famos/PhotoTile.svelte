<script lang="ts">
	/**
	 * The photo of the day: a family photo with its label at the foot in tracked caps
	 * ("From the photos · October 2025", the month from `formatPhotoMonth`). The label sits on
	 * the scrim in the day palette so it reads on any photo; the photo dims a little at night.
	 */
	let {
		src,
		label,
		alt = '',
		height = 180,
	}: {
		src: string;
		label: string;
		/** The photo has no description of its own; the label names it. */
		alt?: string;
		height?: number;
	} = $props();
</script>

<figure class="photo" style:height="{height}px" data-testid="photo-tile">
	<img {src} {alt} loading="lazy" decoding="async" />
	<figcaption class="day">{label}</figcaption>
</figure>

<style>
	.photo {
		position: relative;
		margin: 0;
		overflow: hidden;
		border-radius: 16px;
		background: var(--idle);
	}
	img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	:global(.dark) img {
		filter: brightness(0.82);
	}
	figcaption {
		position: absolute;
		inset: auto 0 0;
		padding: 28px 14px 12px;
		background: linear-gradient(to top, var(--scrim), transparent);
		color: var(--on-color);
		font-size: 0.6875rem;
		font-weight: 800;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}
</style>
