<script lang="ts">
	/**
	 * A thing's details in a panel, read only: each a small uppercase label above its value, rows
	 * with no value left out. What a `SidePanel` with `readFirst` shows before "Suggest a change".
	 * All texts are already translated.
	 */
	let { rows }: { rows: readonly { label: string; value: string | null | undefined }[] } = $props();
	const shown = $derived(rows.filter((row) => row.value?.trim()));
</script>

<dl class="grid gap-3 text-sm" data-testid="detail-rows">
	{#each shown as row (row.label)}
		<div class="grid gap-0.5">
			<dt class="text-ink-soft text-xs font-semibold tracking-widest uppercase">{row.label}</dt>
			<dd class="break-words whitespace-pre-line">{row.value}</dd>
		</div>
	{/each}
</dl>
