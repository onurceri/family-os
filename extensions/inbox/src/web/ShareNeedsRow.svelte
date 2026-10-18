<script lang="ts">
	import { TodayRow } from '@famos/ui/famos';
	import { Inbox } from '@lucide/svelte';
	import type { Draft } from './data.js';
	import { useInbox } from './i18n.js';

	/**
	 * Everything one shared item made, as one line of Today's Needs you: the group in Quick add
	 * decides them together, so Today counts them once and opens that group.
	 */
	let { drafts, sourceId }: { drafts: readonly Draft[]; sourceId: string } = $props();
	const { app, t } = useInbox();

	const sharer = $derived.by(() => {
		const by = drafts[0]?.proposedBy as { onBehalfOf?: string } | null;
		return by?.onBehalfOf ? app.members().find((m) => m.id === by.onBehalfOf) : undefined;
	});
	const title = $derived(
		drafts.find((d) => d.summary)?.summary ??
			(sharer
				? t('share_waiting_title', { name: sharer.displayName })
				: t('share_waiting_untitled')),
	);
	const meta = $derived(
		[
			sharer ? t('from', { name: sharer.displayName }) : '',
			t('share_waiting_count', { count: drafts.length }),
		]
			.filter(Boolean)
			.join(' · '),
	);
</script>

<TodayRow
	variant="needs"
	icon={Inbox}
	{title}
	{meta}
	uncertain={drafts.some((d) => d.uncertainFields.length > 0)}
	href="/add?capture={encodeURIComponent(sourceId)}"
/>
