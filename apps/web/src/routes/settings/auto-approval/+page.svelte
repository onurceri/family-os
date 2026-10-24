<script lang="ts">
	import { type paths } from '@famos/api-client';
	import {
		Card,
		EmptyState,
		HelpTip,
		Notice,
		Page,
		PageHeader,
		Section,
		SettingRow,
		SwitchRow,
	} from '@famos/ui/famos';
	import { api } from '#lib/api.js';
	import { runAction } from '#lib/run-action.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import { session } from '#lib/session.svelte.js';

	type Listed =
		paths['/api/v1/core/auto-approval']['get']['responses'][200]['content']['application/json'];
	type Entry = Listed['actions'][number];

	let actions = $state<Entry[]>([]);
	let loaded = $state(false);
	let error = $state<string | null>(null);

	async function load() {
		const result = await runAction(api.GET('/api/v1/core/auto-approval'), {
			onError: (failure) => (error = failure.message),
		});
		if (!result.ok) return;
		actions = result.data.actions;
		loaded = true;
	}

	$effect(() => {
		if (session.can('core.autoApprove.manage')) void load();
	});

	/** Saves the setting of one action (null turns it off), then shows what is stored. */
	async function save(actionId: string, setting: { proposerCapability: string } | null) {
		error = null;
		await runAction(
			api.POST('/api/v1/actions/core.setAutoApproval', { body: { actionId, setting } }),
			{
				saved: t('auto_approval_saved'),
				onError: (failure) => (error = failure.message),
			},
		);
		await load();
	}
</script>

<Page template="settings">
	<PageHeader title={t('auto_approval_title')} subtitle={t('auto_approval_short')} />

	<div class="grid gap-7">
		{#if error}<Notice tone="alert">{error}</Notice>{/if}

		{#if loaded && actions.length === 0}
			<EmptyState art="generic" title={t('auto_approval_empty')}></EmptyState>
		{:else if actions.length}
			<Section label={t('auto_approval_list')}>
				<Card rows>
					{#each actions as entry (entry.actionId)}
						{@const setting = entry.setting}
						<div>
							<SwitchRow
								id="auto-on-{entry.actionId}"
								label={tDynamic(entry.labelKey)}
								hint={setting
									? t('auto_approval_on_by', { name: setting.enabledByName ?? '' })
									: t('auto_approval_off_hint')}
								checked={setting !== null}
								onchange={(on) =>
									save(
										entry.actionId,
										on ? { proposerCapability: entry.choices[0]?.value ?? '' } : null,
									)}
							/>
							{#if setting}
								<SettingRow
									label={t('auto_approval_proposer_label')}
									for="auto-who-{entry.actionId}"
								>
									{#snippet control()}
										<select
											id="auto-who-{entry.actionId}"
											class="border-input bg-wall min-h-[var(--ctl)] w-full rounded-[var(--r-ctl)] border px-3 text-[15px]"
											value={setting.proposerCapability}
											onchange={(e) =>
												save(entry.actionId, { proposerCapability: e.currentTarget.value })}
										>
											{#each entry.choices as choice (choice.value)}
												<option value={choice.value}>{tDynamic(choice.labelKey)}</option>
											{/each}
										</select>
									{/snippet}
								</SettingRow>
							{/if}
						</div>
					{/each}
				</Card>
				<Notice>
					{t('auto_approval_undo_note')}
					<HelpTip text={t('auto_approval_intro')} label={t('help')} />
				</Notice>
			</Section>
		{/if}
	</div>
</Page>
