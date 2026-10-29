<script lang="ts">
	import type { HTMLTextareaAttributes } from "svelte/elements";
	import { findApp } from "../../app-context.js";
	import { counterText, type LengthState, lengthState } from "../../famos/length-limit.js";
	import LimitCounter from "../../famos/LimitCounter.svelte";

	let {
		ref = $bindable(null),
		value = $bindable(),
		maxlength,
		...restProps
	}: HTMLTextareaAttributes & { ref?: HTMLTextAreaElement | null } = $props();

	// Like `Input`: a limit never cuts what is typed or pasted. A counter shows near it, a message
	// over it, and the field is invalid until the text is shorter.
	const usage = $derived(lengthState(String(value ?? ""), maxlength ?? 0));
	const over = $derived(typeof maxlength === "number" && usage.over);
	const app = findApp();
	const tooLong = (counter: string, state: LengthState) =>
		app?.t("app:too_long", { length: state.length, max: state.max }) ?? counter;
	$effect(() => {
		ref?.setCustomValidity(over ? tooLong(counterText(usage), usage) : "");
	});
</script>

<textarea
	bind:this={ref}
	bind:value
	{...restProps}
	data-counted={typeof maxlength === "number" ? "" : undefined}
	aria-invalid={over ? "true" : restProps["aria-invalid"]}
></textarea>
{#if typeof maxlength === "number"}
	<LimitCounter text={String(value ?? "")} max={maxlength} {tooLong} />
{/if}
