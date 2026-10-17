<script lang="ts">
	import { Card, Page, PageHeader, Section, SwitchRow } from '@famos/ui/famos';
	import { onDestroy, onMount } from 'svelte';
	import type { MySharing, SharingLevel } from '../contract/index.js';
	import { loadMySharing, setMySharing } from './data.js';
	import { useHomeAssistant } from './i18n.js';

	/**
	 * Settings, You, Home Assistant: what FamilyOS shows about where the signed-in person is.
	 * Only they choose it; an admin links them to a Home Assistant person and sees the choice,
	 * nothing more. Saved as it is chosen.
	 */
	const { app, t } = useHomeAssistant();

	let sharing = $state<MySharing | null>(null);
	let busy = $state(false);

	async function load() {
		try {
			sharing = await loadMySharing();
		} catch {
			sharing ??= { linked: false };
		}
	}
	let off: (() => void) | undefined;
	onMount(() => {
		void load();
		// Linked or unlinked by an admin while the page is open.
		off = app.onEvent('homeassistant.people', () => void load());
	});
	onDestroy(() => off?.());

	const linked = $derived(sharing?.linked ? sharing : null);

	const LEVELS = [
		{ level: 'none', label: 'mine_none', hint: 'mine_none_hint' },
		{ level: 'home', label: 'mine_home', hint: 'mine_home_hint' },
		{ level: 'place', label: 'mine_place', hint: 'mine_place_hint' },
	] as const satisfies readonly { level: SharingLevel; label: string; hint: string }[];

	/** Shown at once; put back as it was when the server does not take it. */
	async function save(level: SharingLevel, onDisplays: boolean) {
		if (!linked) return;
		const before = { ...linked };
		sharing = { linked: true, level, onDisplays: level !== 'none' && onDisplays };
		busy = true;
		try {
			await setMySharing({ level, onDisplays: level !== 'none' && onDisplays });
		} catch {
			sharing = before;
			app.toast(t('mine_error'));
		} finally {
			busy = false;
		}
	}

	const capability = $derived(t('cap_presence'));
</script>

<Page template="settings">
	<PageHeader title={t('nav_label')} />
	{#if sharing && !linked}
		<Card variant="quiet" pad>
			<p class="font-semibold">{t('mine_not_linked')}</p>
			<p class="text-ink-soft mt-1 max-w-prose text-sm">{t('mine_not_linked_hint')}</p>
		</Card>
	{:else if linked}
		<div class="grid gap-7">
			<Section label={t('mine_show_label')}>
				<fieldset class="m-0 border-0 p-0" disabled={busy} aria-label={t('mine_show_label')}>
					<Card rows>
						{#each LEVELS as choice (choice.level)}
							<label class="flex min-h-14 cursor-pointer items-center gap-3 px-3 py-2">
								<input
									type="radio"
									name="ha-sharing"
									value={choice.level}
									checked={linked.level === choice.level}
									onchange={() => void save(choice.level, linked.onDisplays)}
									aria-labelledby="ha-sharing-{choice.level}-label"
									aria-describedby="ha-sharing-{choice.level}-hint"
									class="accent-ink size-5 shrink-0"
								/>
								<span class="grid min-w-0 flex-1 gap-0.5">
									<span id="ha-sharing-{choice.level}-label" class="text-[15px] font-semibold"
										>{t(choice.label)}</span
									>
									<small id="ha-sharing-{choice.level}-hint" class="text-ink-soft text-[13px]"
										>{t(choice.hint)}</small
									>
								</span>
							</label>
						{/each}
					</Card>
				</fieldset>
			</Section>
			{#if linked.level !== 'none'}
				<Card rows>
					<SwitchRow
						id="ha-sharing-displays"
						label={t('mine_displays')}
						hint={t('mine_displays_hint', { capability })}
						checked={linked.onDisplays}
						disabled={busy}
						onchange={(on) => void save(linked.level, on)}
					/>
				</Card>
			{/if}
			<p class="text-ink-soft max-w-prose text-[13px]">{t('mine_who', { capability })}</p>
		</div>
	{/if}
</Page>
