<script lang="ts">
	import { Card, IconButton, Row, Section } from '@famos/ui/famos';
	import { Label } from '@famos/ui/label';
	import { ArrowDown, ArrowUp, X } from '@lucide/svelte';
	import { contributions, enabledOnly } from '#lib/extensions.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import SelectField from '#lib/SelectField.svelte';
	import { session } from '#lib/session.svelte.js';
	import {
		addablePages,
		BACK_SECONDS,
		listedPages,
		movePage,
		PAGE_SECONDS,
		TODAY_SECONDS,
		withCurrent,
	} from './display-pages.js';

	/**
	 * A screen's pages: which pages it shows between Today's turns, in what order, and for how long.
	 * Today always comes first and is not listed. Only pages whose permission is ticked in the form
	 * above are offered, and one whose permission is unticked leaves the list (it is not saved).
	 */
	let {
		idPrefix,
		ticked,
		pages = $bindable(),
		todaySeconds = $bindable(),
		pageSeconds = $bindable(),
		backSeconds = $bindable(),
	}: {
		idPrefix: string;
		/** The permissions ticked for the screen. */
		ticked: readonly string[];
		pages: string[];
		todaySeconds: number;
		pageSeconds: number;
		backSeconds: number;
	} = $props();

	const offered = $derived(
		enabledOnly(
			contributions.slots.filter((c) => c.slot === 'display.page'),
			session.disabledExtensions,
		),
	);
	const listed = $derived(listedPages(offered, ticked, pages, []));
	const addable = $derived(addablePages(offered, ticked, pages, []));
	const nameOf = (c: { id: string; labelKey?: string }) =>
		c.labelKey ? tDynamic(c.labelKey) : c.id;

	// A page whose permission was unticked leaves the list, and so is not saved.
	$effect(() => {
		const keep = listed.map((c) => c.id);
		if (keep.length !== pages.length) pages = keep;
	});

	const seconds = (value: number) =>
		value >= 60 && value % 60 === 0
			? t('devices_pages_minutes', { n: value / 60 })
			: t('devices_pages_seconds', { n: value });
</script>

{#if listed.length > 0 || addable.length > 0}
	<div class="grid gap-3" data-testid="display-pages">
		<Section label={t('devices_pages')}>
			<p class="text-ink-soft text-[13px]">{t('devices_pages_hint')}</p>
			{#if listed.length > 0}
				<Card rows>
					{#each listed as page, i (page.id)}
						<Row title={nameOf(page)}>
							{#snippet trail()}
								<IconButton
									size="sm"
									label={t('devices_pages_up', { name: nameOf(page) })}
									disabled={i === 0}
									onclick={() => (pages = movePage(pages, i, -1))}
								>
									<ArrowUp class="size-4" aria-hidden="true" />
								</IconButton>
								<IconButton
									size="sm"
									label={t('devices_pages_down', { name: nameOf(page) })}
									disabled={i === listed.length - 1}
									onclick={() => (pages = movePage(pages, i, 1))}
								>
									<ArrowDown class="size-4" aria-hidden="true" />
								</IconButton>
								<IconButton
									size="sm"
									label={t('devices_pages_remove', { name: nameOf(page) })}
									onclick={() => (pages = pages.filter((id) => id !== page.id))}
								>
									<X class="size-4" aria-hidden="true" />
								</IconButton>
							{/snippet}
						</Row>
					{/each}
				</Card>
			{/if}
			{#if addable.length > 0}
				<SelectField
					aria-label={t('devices_pages_add')}
					value=""
					onchange={(event: Event & { currentTarget: HTMLSelectElement }) => {
						const id = event.currentTarget.value;
						event.currentTarget.value = '';
						if (id) pages = [...pages, id];
					}}
				>
					<option value="">{t('devices_pages_add')}</option>
					{#each addable as page (page.id)}
						<option value={page.id}>{nameOf(page)}</option>
					{/each}
				</SelectField>
			{/if}
		</Section>
		{#if listed.length > 0}
			<div class="grid gap-1.5">
				<Label for="{idPrefix}-today-for">{t('devices_pages_today_for')}</Label>
				<SelectField id="{idPrefix}-today-for" bind:value={todaySeconds}>
					{#each withCurrent(TODAY_SECONDS, todaySeconds) as value (value)}
						<option {value}>{seconds(value)}</option>
					{/each}
				</SelectField>
			</div>
			<div class="grid gap-1.5">
				<Label for="{idPrefix}-page-for">{t('devices_pages_each_for')}</Label>
				<SelectField id="{idPrefix}-page-for" bind:value={pageSeconds}>
					{#each withCurrent(PAGE_SECONDS, pageSeconds) as value (value)}
						<option {value}>{seconds(value)}</option>
					{/each}
				</SelectField>
			</div>
			<div class="grid gap-1.5">
				<Label for="{idPrefix}-back-in">{t('devices_pages_back_in')}</Label>
				<SelectField id="{idPrefix}-back-in" bind:value={backSeconds}>
					{#each withCurrent(BACK_SECONDS, backSeconds) as value (value)}
						<option {value}>{seconds(value)}</option>
					{/each}
				</SelectField>
			</div>
		{/if}
	</div>
{/if}
