<script lang="ts">
	import { Pill, Switch } from '@famos/ui/famos';
	import { ChevronRight } from '@lucide/svelte';
	import { t } from '#lib/i18n.svelte.js';
	import { kindAnchor } from './groups.js';

	/**
	 * One kind of notification as a matrix row: what it is (with "Optional" when it is only for
	 * those who switch it on, a line saying what it is, and a link to where it is set up), then a
	 * switch per channel in fixed columns under the section's column heads. Without channels it is
	 * the text alone. With `stacked` (three channels or more) a narrow card puts each channel's name
	 * and switch under the text instead of columns.
	 */
	let {
		kind,
		channels,
		isOn,
		onchange,
		linkShown,
		stacked = false,
		highlighted = false,
	}: {
		kind: {
			id: string;
			label: string;
			optIn: boolean;
			description?: string;
			link?: { path: string; label: string };
		};
		channels: readonly { id: string; label: string }[];
		isOn: (channelId: string) => boolean;
		onchange: (channelId: string, enabled: boolean) => void;
		/** Whether the kind's link leads to a page of the app this person has. */
		linkShown: boolean;
		stacked?: boolean;
		highlighted?: boolean;
	} = $props();

	const id = $props.id();
</script>

<div id={kindAnchor(kind.id)} class="kind" class:stacked class:highlighted>
	<div class="txt">
		<span class="title"
			>{kind.label}{#if kind.optIn}<span class="pill"><Pill>{t('notify_optional')}</Pill></span
				>{/if}</span
		>
		{#if kind.description}<span class="desc">{kind.description}</span>{/if}
		{#if kind.link && linkShown}
			<a class="link" href={kind.link.path}
				>{kind.link.label}<ChevronRight class="size-3.5" aria-hidden="true" /></a
			>
		{/if}
	</div>
	{#if channels.length > 0}
		<div class="cells">
			{#each channels as channel (channel.id)}
				<label class="cell" for="{id}-{channel.id}">
					<span class="name">{channel.label}</span>
					<Switch
						id="{id}-{channel.id}"
						checked={isOn(channel.id)}
						label={t('notify_switch_label', { kind: kind.label, channel: channel.label })}
						onchange={(enabled) => onchange(channel.id, enabled)}
					/>
				</label>
			{/each}
		</div>
	{/if}
</div>

<style>
	.kind {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 52px;
		padding: 0 12px;
		transition: background-color 300ms ease-out;
	}
	.highlighted {
		background: var(--idle);
	}
	.txt {
		display: grid;
		flex: 1;
		min-width: 0;
		gap: 2px;
		padding: 10px 0;
	}
	.title {
		font-size: 0.9375rem;
		font-weight: 600;
		line-height: 1.3;
		color: var(--ink);
		overflow-wrap: anywhere;
	}
	.pill {
		display: inline-flex;
		margin-inline-start: 6px;
		vertical-align: middle;
	}
	.desc {
		font-size: 0.8125rem;
		color: var(--ink-soft);
	}
	.link {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		justify-self: start;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--info);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	/* The cells sit in the row itself, so they line up with the section's column heads. */
	.cells {
		display: contents;
	}
	.cell {
		display: flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: 72px;
		min-height: 52px;
		cursor: pointer;
	}
	.name {
		display: none;
	}
	@container notify-kinds (max-width: 32rem) {
		.stacked {
			flex-wrap: wrap;
		}
		.stacked .txt {
			flex-basis: 100%;
			padding-bottom: 0;
		}
		.stacked .cells {
			display: flex;
			flex-wrap: wrap;
			gap: 0 12px;
			padding-bottom: 4px;
		}
		.stacked .cell {
			width: auto;
			min-height: 44px;
			gap: 8px;
		}
		.stacked .name {
			display: inline;
			font-size: 0.8125rem;
			font-weight: 600;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.kind {
			transition: none;
		}
	}
</style>
