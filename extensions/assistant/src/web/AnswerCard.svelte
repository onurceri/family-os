<script lang="ts">
	import { Avatar, Section } from '@famos/ui/famos';
	import { todayIn } from '@famos/time';
	import type { CardWords } from '../contract/card-words.js';
	import type { AnswerCard } from '../contract/index.js';
	import { cardView, colorOf } from './card-view.js';
	import { useAssistant } from './i18n.js';

	/**
	 * The facts of a question's answer, drawn from the stored card: what was understood, each topic
	 * as a label with its items as rows, what is not here. Rows are plain: the card holds no
	 * identifiers, so nothing here can open a record.
	 */
	let { card }: { card: AnswerCard } = $props();
	const { app, t } = useAssistant();
	const words = $derived<CardWords>({
		t: (key, params) => t(key as never, params as never),
		dateLocale: app.dateLocale(),
		hourCycle: app.hourCycle(),
		today: todayIn(app.timeZone(), Date.now()),
	});
	const view = $derived(cardView(card, words));
	const members = $derived(app.members());
</script>

<div class="card" role="group" aria-label={t('card_answer')} data-testid="answer-card">
	<p class="understood">
		<span class="font-semibold">{t('card_understood')}</span>
		{' · ' + view.understood.join(' · ')}
	</p>
	{#each view.notices as notice, i (i)}
		<p class="understood">{notice}</p>
	{/each}
	{#each view.sections as section (section.topic)}
		<Section label={section.label} level={3}>
			{#if section.empty}
				<p class="quiet" data-testid="card-empty">{section.empty}</p>
			{:else}
				<ul class="rows">
					{#each section.rows as row, i (i)}
						<li class="row">
							{#if row.when}<span class="when">{row.when}</span>{/if}
							<div class="body">
								<p class="title">{row.title}</p>
								{#if row.facts.length > 0}<p class="meta">{row.facts.join(' · ')}</p>{/if}
								{#each row.state as state, j (j)}<p class="state">{state}</p>{/each}
								{#if row.people.length > 0}
									<ul class="people" aria-label={row.people.join(', ')}>
										{#each row.people as name (name)}
											{@const color = colorOf(name, members)}
											<li class="person">
												{#if color}<Avatar {name} {color} size={20} />{/if}
												<span>{name}</span>
											</li>
										{/each}
									</ul>
								{/if}
								{#if row.notes}<p class="notes">{row.notes}</p>{/if}
							</div>
						</li>
					{/each}
				</ul>
			{/if}
			{#if section.more}<p class="quiet">{section.more}</p>{/if}
			{#if section.hidden}<p class="quiet">{section.hidden}</p>{/if}
		</Section>
	{/each}
	{#each view.notHere as line, i (i)}
		<p class="quiet" data-testid="card-not-here">{line}</p>
	{/each}
</div>

<style>
	.card {
		display: grid;
		gap: 16px;
		min-width: 0;
		padding: 14px 16px;
		border-radius: var(--r-card);
		background: var(--surface);
		box-shadow: inset 0 0 0 1px var(--line);
		container-type: inline-size;
	}
	.understood {
		color: var(--ink-soft);
		font-size: 13px;
		line-height: 1.4;
		overflow-wrap: anywhere;
	}
	.quiet {
		color: var(--ink-soft);
		font-size: 14px;
		line-height: 1.45;
		overflow-wrap: anywhere;
	}
	.rows {
		display: grid;
		min-width: 0;
	}
	.row {
		display: grid;
		gap: 2px;
		min-width: 0;
		padding-block: 8px;
		border-top: 1px solid var(--line);
	}
	.row:first-child {
		border-top: 0;
		padding-top: 0;
	}
	.when {
		color: var(--ink-soft);
		font-size: 13px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		overflow-wrap: anywhere;
	}
	.body {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.title {
		font-size: 15px;
		font-weight: 600;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}
	.meta {
		color: var(--ink-soft);
		font-size: 13px;
		overflow-wrap: anywhere;
	}
	.state {
		color: var(--attention);
		font-size: 13px;
		font-weight: 700;
		overflow-wrap: anywhere;
	}
	.people {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 10px;
		margin-top: 2px;
	}
	.person {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		font-weight: 600;
	}
	.notes {
		display: -webkit-box;
		overflow: hidden;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		color: var(--ink-soft);
		font-size: 13px;
		line-height: 1.4;
		overflow-wrap: anywhere;
	}
	@container (min-width: 30rem) {
		.row {
			grid-template-columns: 13rem minmax(0, 1fr);
			gap: 16px;
		}
		.row:not(:has(.when)) {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
