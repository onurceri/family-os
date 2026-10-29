<script lang="ts">
	import type { SlotProps } from '@famos/ui/slots';
	import { SidePanel } from '@famos/ui/famos';
	import { Plus } from '@lucide/svelte';
	import type { InboxItem } from '../contract/index.js';
	import CaptureBox from './CaptureBox.svelte';
	import CaptureGroup from './CaptureGroup.svelte';
	import { CaptureFeed } from './feed.svelte.js';
	import { useInbox } from './i18n.js';
	import NoAiNote from './NoAiNote.svelte';

	/**
	 * The "+" icon button of the sidebar head and the tablet rail (slot `nav.action`): opens the
	 * capture box in a side panel from any page. After **Send** the panel follows that
	 * capture: Reading…, its suggestions, Add selected. On the Quick add page itself the button
	 * only moves to the box that is already there.
	 */
	let { variant }: SlotProps['nav.action'] = $props();
	const { app, t } = useInbox();

	let open = $state(false);
	let ids = $state<string[]>([]);
	const feed = new CaptureFeed(app);
	$effect(() => (open ? feed.start() : undefined));

	const groups = $derived(ids.flatMap((id) => feed.capture(id) ?? []));
	const id = $derived(`quick-add-text-panel-${variant}`);

	function toggle() {
		if (location.pathname === '/add') {
			const box = document.getElementById('quick-add-text');
			box?.scrollIntoView({ block: 'center' });
			box?.focus();
			return;
		}
		open = true;
	}
	function close() {
		open = false;
		ids = [];
	}
	function sent(item: InboxItem) {
		feed.add(item);
		ids = [item.id, ...ids];
	}
</script>

<!-- An icon button, never a filled one: the sidebar head row (36 px) and the tablet rail (44 px). -->
<button
	type="button"
	onclick={toggle}
	aria-label={t('button')}
	title={variant === 'sidebar' ? `${t('button')} · n` : t('button')}
	aria-keyshortcuts="n"
	data-testid="quick-add-button"
	class="text-ink-soft hover:bg-idle hover:text-ink focus-visible:ring-ring grid shrink-0 place-items-center rounded-xl outline-none focus-visible:ring-2 {variant ===
	'sidebar'
		? 'size-9'
		: 'size-11'} {open ? 'bg-surface text-ink shadow-lit' : ''}"
>
	<Plus class="size-5" aria-hidden="true" />
</button>

<SidePanel {open} title={t('title')} onclose={close} closeLabel={t('close')}>
	<div class="grid content-start gap-5">
		<CaptureBox onsent={sent} {id} compact />
		<NoAiNote />
		{#each groups as capture (capture.item.id)}
			<CaptureGroup {capture} onchanged={() => void feed.load()} />
		{/each}
		<a
			href="/add"
			onclick={close}
			class="text-ink-soft hover:text-ink justify-self-start text-sm font-semibold underline underline-offset-4"
			>{t('open_quick_add')}</a
		>
	</div>
</SidePanel>
