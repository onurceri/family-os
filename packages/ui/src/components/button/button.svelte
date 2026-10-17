<script lang="ts" module>
	import { type VariantProps, tv } from "tailwind-variants";
	import { cn, type WithElementRef } from "../../utils.js";
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";

	export const buttonVariants = tv({
		base: "group/button inline-flex shrink-0 items-center justify-center gap-2 rounded-[var(--r-ctl)] border border-transparent text-[15px] leading-none font-semibold whitespace-nowrap transition-colors duration-150 ease-out outline-none select-none focus-visible:shadow-[0_0_0_2px_var(--wall),0_0_0_4px_var(--info)] disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45 motion-reduce:transition-none [&_svg:not([class*='size-'])]:size-[18px] [&_svg]:pointer-events-none [&_svg]:shrink-0",
		variants: {
			variant: {
				// One filled button per view: `primary` (ink) is the view's main action; the rest stay quiet.
				primary: "bg-ink text-surface hover:bg-[color-mix(in_oklab,var(--ink)_86%,var(--surface))]",
				secondary: "bg-idle text-ink hover:bg-[color-mix(in_oklab,var(--idle)_90%,var(--ink))]",
				outline: "border-line bg-transparent text-ink hover:bg-idle",
				ghost: "bg-transparent text-ink-soft hover:bg-idle hover:text-ink aria-expanded:bg-idle aria-expanded:text-ink",
				go: "bg-attention text-on-color hover:bg-[color-mix(in_oklab,var(--attention)_90%,var(--ink))]",
				danger: "bg-transparent text-destructive hover:bg-[color-mix(in_oklab,var(--destructive)_10%,transparent)] data-[armed=true]:bg-destructive data-[armed=true]:text-on-color",
				link: "rounded-sm text-info underline underline-offset-3 decoration-1 hover:decoration-2",
			},
			size: {
				default: "h-[var(--ctl)] px-3.5",
				xs: "h-6 gap-1 rounded-lg px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
				sm: "h-9 px-3 text-sm",
				lg: "h-11 px-[18px]",
				kiosk: "h-13 px-[22px] text-[17px]",
				icon: "size-[var(--ctl)] px-0",
				"icon-xs": "size-6 rounded-lg px-0 [&_svg:not([class*='size-'])]:size-3",
				"icon-sm": "size-9 px-0",
				"icon-lg": "size-11 px-0",
			},
		},
		compoundVariants: [{ variant: "link", class: "h-auto px-0" }],
		defaultVariants: {
			variant: "primary",
			size: "default",
		},
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
	export type ButtonSize = VariantProps<typeof buttonVariants>["size"];

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
		};
</script>

<script lang="ts">
	let {
		class: className,
		variant = "primary",
		size = "default",
		ref = $bindable(null),
		href = undefined,
		type = "button",
		disabled,
		children,
		...restProps
	}: ButtonProps = $props();
</script>

{#if href}
	<a
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		href={disabled ? undefined : href}
		aria-disabled={disabled}
		role={disabled ? "link" : undefined}
		tabindex={disabled ? -1 : undefined}
		{...restProps}
	>
		{@render children?.()}
	</a>
{:else}
	<button
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		{type}
		{disabled}
		{...restProps}
	>
		{@render children?.()}
	</button>
{/if}
