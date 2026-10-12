<script lang="ts">
	import type { HTMLTextareaAttributes } from "svelte/elements";
	import { findApp } from "../../app-context.js";
	import { lengthState } from "../../famos/length-limit.js";
	import LimitCounter from "../../famos/LimitCounter.svelte";

	let {
		ref = $bindable(null),
		value = $bindable(),
		maxlength,
		...restProps
	}: HTMLTextareaAttributes & { ref?: HTMLTextAreaElement | null } = $props();

	// Like `Input`: a limit never cuts what is typed or pasted. A counter shows near it, a message
	// over it, and the field is invalid until the text is shorter.
	const over = $derived(
		typeof maxlength === "number" && lengthState(String(value ?? ""), maxlength).over
	);
	const app = findApp();
	const tooLong = (counter: string) => app?.t("app:too_long", { counter }) ?? counter;
	$effect(() => {
		ref?.setCustomValidity(
			over ? tooLong(`${String(value ?? "").trim().length}/${maxlength}`) : ""
		);
	});
</script>

<textarea
	bind:this={ref}
	bind:value
	{...restProps}
	aria-invalid={over ? "true" : restProps["aria-invalid"]}
></textarea>
{#if typeof maxlength === "number"}
	<LimitCounter text={String(value ?? "")} max={maxlength} {tooLong} />
{/if}
