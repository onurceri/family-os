<script lang="ts">
	import { cn, type WithElementRef } from "../../utils.js";
	import type { HTMLInputAttributes, HTMLInputTypeAttribute } from "svelte/elements";
	import { findApp } from "../../app-context.js";
	import LimitCounter from "../../famos/LimitCounter.svelte";
	import { lengthState } from "../../famos/length-limit.js";

	type InputType = Exclude<HTMLInputTypeAttribute, "file">;

	type Props = WithElementRef<
		Omit<HTMLInputAttributes, "type"> &
			({ type: "file"; files?: FileList } | { type?: InputType; files?: undefined })
	>;

	let {
		ref = $bindable(null),
		value = $bindable(),
		type,
		files = $bindable(),
		class: className,
		"data-slot": dataSlot = "input",
		maxlength,
		...restProps
	}: Props = $props();

	// A long text field never cuts what is typed or pasted: a counter shows near the limit and a
	// message over it, and the field is invalid (a form that validates refuses it) until it is
	// shorter. Short fields (a year, a code) keep the browser's hard limit.
	const COUNTED_FROM = 40;
	const counted = $derived(
		type !== "file" && typeof maxlength === "number" && maxlength >= COUNTED_FROM
	);
	const over = $derived(
		counted && lengthState(String(value ?? ""), maxlength as number).over
	);
	const app = findApp();
	const tooLong = (counter: string) => app?.t("app:too_long", { counter }) ?? counter;
	$effect(() => {
		(ref as HTMLInputElement | null)?.setCustomValidity(
			over ? tooLong(`${String(value ?? "").trim().length}/${maxlength}`) : ""
		);
	});
</script>

{#if type === "file"}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={cn(
			"bg-surface in-data-[surface=card]:bg-wall text-ink border-line focus-visible:border-info focus-visible:ring-info/25 aria-invalid:border-attention aria-invalid:border-[1.5px] aria-invalid:ring-0 h-[var(--ctl)] rounded-[var(--r-ctl)] border px-3 text-[15px] transition-[color,box-shadow] file:h-7 file:text-sm file:font-medium focus-visible:ring-3 w-full min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent file:text-foreground placeholder:text-ink-soft/80 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
			className
		)}
		type="file"
		bind:files
		bind:value
		{...restProps}
	/>
{:else}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={cn(
			"bg-surface in-data-[surface=card]:bg-wall text-ink border-line focus-visible:border-info focus-visible:ring-info/25 aria-invalid:border-attention aria-invalid:border-[1.5px] aria-invalid:ring-0 h-[var(--ctl)] rounded-[var(--r-ctl)] border px-3 text-[15px] transition-[color,box-shadow] file:h-7 file:text-sm file:font-medium focus-visible:ring-3 w-full min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent file:text-foreground placeholder:text-ink-soft/80 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
			className
		)}
		{type}
		bind:value
		maxlength={counted ? undefined : maxlength}
		{...restProps}
		aria-invalid={over ? "true" : restProps["aria-invalid"]}
	/>
	{#if counted}
		<LimitCounter text={String(value ?? "")} max={maxlength as number} {tooLong} />
	{/if}
{/if}
