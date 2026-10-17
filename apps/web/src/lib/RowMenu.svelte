<script lang="ts">
	import { IconButton, Menu, type MenuItem } from '@famos/ui/famos';
	import { Ellipsis } from '@lucide/svelte';
	import { t } from '#lib/i18n.svelte.js';

	/**
	 * The `...` button of a row: a popover Menu on wide windows, an ActionSheet on phones, where a
	 * small popover is hard to hit. `name` is the row's name, so the button says `Options for Amy`.
	 */
	let { name, items }: { name: string; items: MenuItem[] } = $props();
	const label = $derived(t('row_options', { name }));
</script>

<Menu {items} {label} title={name} cancelLabel={t('cancel')}>
	{#snippet trigger({ attrs })}
		<IconButton {label} {...attrs}><Ellipsis class="size-5" aria-hidden="true" /></IconButton>
	{/snippet}
</Menu>
