<script lang="ts">
	import { ActionSheet, IconButton, Menu, type MenuItem, wide } from '@famos/ui/famos';
	import { Ellipsis } from '@lucide/svelte';
	import { t } from '#lib/i18n.svelte.js';

	/**
	 * The `...` button of a row: a popover Menu on wide windows, an ActionSheet on phones, where a
	 * small popover is hard to hit. `name` is the row's name, so the button says `Options for Amy`.
	 */
	let { name, items }: { name: string; items: MenuItem[] } = $props();
	let sheet = $state(false);
	const label = $derived(t('row_options', { name }));
</script>

{#if wide.current}
	<Menu {items} {label}>
		{#snippet trigger({ attrs })}
			<IconButton {label} {...attrs}><Ellipsis class="size-5" aria-hidden="true" /></IconButton>
		{/snippet}
	</Menu>
{:else}
	<IconButton {label} aria-haspopup="menu" onclick={() => (sheet = true)}>
		<Ellipsis class="size-5" aria-hidden="true" />
	</IconButton>
	<ActionSheet bind:open={sheet} title={name} {items} cancelLabel={t('cancel')} />
{/if}
