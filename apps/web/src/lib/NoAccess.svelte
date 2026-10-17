<script lang="ts">
	import { Button } from '@famos/ui/button';
	import { EmptyState, Page } from '@famos/ui/famos';
	import { t, tDynamic } from '#lib/i18n.svelte.js';

	/**
	 * What someone sees on a page that is not for them (a typed address, a bookmark, a link
	 * someone sent): the page's name, who it is for, and the way back to Today. Never a redirect:
	 * the person learns why the page did not open.
	 */
	let {
		labelKey,
		settings,
	}: {
		/** The page's name as its navigation entry has it (`nav_members`, `homeassistant:nav_label`). */
		labelKey: string | undefined;
		/** A settings page keeps the settings frame. */
		settings: boolean;
	} = $props();

	const name = $derived(
		labelKey ? tDynamic(labelKey.includes(':') ? labelKey : `app:${labelKey}`) : undefined,
	);
</script>

<Page template={settings ? 'settings' : 'list'} title={name}>
	<EmptyState
		art="generic"
		title={name ? t('no_access_title', { name }) : t('no_access_title_unnamed')}
		hint={t('no_access_hint')}
	>
		<Button variant="outline" href="/">{t('no_access_back')}</Button>
	</EmptyState>
</Page>
