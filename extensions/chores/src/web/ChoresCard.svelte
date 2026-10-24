<script lang="ts">
	import { todayIn } from '@famos/time';
	import { Avatar, TodayRow, TodaySection } from '@famos/ui/famos';
	import type { SlotProps } from '@famos/ui/slots';
	import { useNow } from '@famos/ui/now';
	import type { Chore } from '../contract/index.js';
	import { loadChores, loadTodayByMember, markDone, undoDone } from './data.js';
	import { doneToast, dueLabel, groupOf } from './form.js';
	import { useChores } from './i18n.js';

	/**
	 * Today, notes band: my chores that are due today or late (and the ones anyone may do), one
	 * tap to tick. At a glance (`form: 'glance'`) the page draws the family's chores as rings from
	 * `GET /chores/today`, so the card draws nothing and counts what the rings count.
	 */
	let { size, report, form = 'rows' }: SlotProps['dashboard.card'] = $props();
	const { app, t } = useChores();
	const clock = useNow();
	const now = $derived(clock.current);
	const today = $derived(todayIn(app.timeZone(), now));

	let chores = $state<Chore[]>([]);
	let ringTotal = $state(0);
	let loaded = $state(false);
	let busy = $state<Record<string, true>>({});
	const rings = $derived(form === 'glance' && app.can('chores.view'));
	async function load() {
		try {
			if (rings) ringTotal = (await loadTodayByMember()).reduce((sum, c) => sum + c.total, 0);
			else chores = await loadChores();
		} catch {
			chores = [];
			ringTotal = 0;
		} finally {
			loaded = true;
		}
	}
	$effect(() => {
		void app.offline(); // load again when the connection is back
		void load();
		return app.onEvent('chores.', () => void load());
	});
	const waitingIds = $derived(
		new Set(
			app
				.waiting()
				.filter((w) => w.actionId === 'chores.markDone')
				.map((w) => (w.input as { id: string }).id),
		),
	);

	const me = $derived(app.me()?.id ?? null);
	const mayTick = $derived(app.access('chores.markDone') !== 'no');
	const due = $derived(
		chores
			.filter((c) => ['overdue', 'today'].includes(groupOf(c, today)))
			.filter((c) => c.assigneeId === me || c.assigneeId === null)
			.toSorted((a, b) => Number(b.assigneeId === me) - Number(a.assigneeId === me)),
	);

	const limit = $derived(size === 'wide' ? 5 : 3);
	const shown = $derived(due.slice(0, limit));
	// Reports only once loaded: the page keeps the last report while a card moves between columns.
	$effect(() => {
		if (!loaded) return;
		report({
			count: rings ? ringTotal : due.length,
			quietKey: 'chores:quiet_none',
			urgent: due.filter((c) => groupOf(c, today) === 'overdue').length,
		});
	});

	async function tick(chore: Chore) {
		busy[chore.id] = true;
		try {
			const result = await markDone(app, chore, t('label_done', { title: chore.title }));
			if (result === 'queued') {
				app.toast(t('queued_toast'));
				return;
			}
			if (!result?.completion) {
				await load();
				return;
			}
			const completionId = result.completion.id;
			app.toast(doneToast(chore.title, chore.nextDue, today, t, app.dateLocale()), {
				label: t('undo'),
				run: () => void undoDone(app, completionId, t('label_undo')).then(() => load()),
			});
		} catch {
			app.toast(t('error'));
		} finally {
			delete busy[chore.id];
		}
	}
</script>

{#if size !== 'line' && !rings}
	<TodaySection title={t('card_title')} count={String(due.length)} href="/chores" more={t('nav')}>
		{#each shown as chore (chore.id)}
			{@const assignee = app.members().find((m) => m.id === chore.assigneeId)}
			<TodayRow
				title={chore.title}
				meta={`${dueLabel(chore.nextDue, today, t, app.dateLocale())}${waitingIds.has(chore.id) ? ` · ${t('waiting_to_send')}` : ''}`}
				metaTone={groupOf(chore, today) === 'overdue' ? 'attention' : 'soft'}
				check={mayTick ? false : undefined}
				checkLabel={t('mark_done', { title: chore.title })}
				busy={busy[chore.id] || waitingIds.has(chore.id)}
				oncheck={() => tick(chore)}
			>
				{#snippet trailing()}
					{#if assignee}<Avatar name={assignee.displayName} color={assignee.color} size={26} />{/if}
				{/snippet}
			</TodayRow>
		{/each}
		{#if due.length > shown.length}
			<a href="/chores" class="text-ink-soft hover:text-ink px-2.5 py-1 text-sm font-semibold"
				>{t('today_more', { count: due.length - shown.length })}</a
			>
		{/if}
	</TodaySection>
{/if}
