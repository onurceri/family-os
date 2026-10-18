<script lang="ts">
	import { findApp } from '../app-context.js';
	import { awaitingText, type PresenterContext } from '../slots.js';

	/**
	 * "Waiting for approval" next to a row or a record when a change the signed-in member made to
	 * it waits for someone else to approve it, followed by what the change will make of it ("Due:
	 * Tue 20 Oct"), so the old value on screen is not mistaken for a change that was lost. The
	 * presenter of the change's action words it. Nothing otherwise.
	 */
	let { id }: { id: string } = $props();
	const app = findApp();
	const text = $derived.by(() => {
		const change = app?.awaitedChange(id);
		if (!app || !change) return null;
		const context: PresenterContext = {
			t: app.t,
			members: app.members(),
			formatLocale: app.formatLocale(),
			dateLocale: app.dateLocale(),
			weekStart: app.weekStart(),
			hourCycle: app.hourCycle(),
			timeZone: app.timeZone(),
		};
		return awaitingText({
			input: change.input,
			before: change.before,
			presenter: app.draftPresenter(change.actionId),
			context,
		});
	});
</script>

{#if text !== null}
	<span
		class="text-ink-soft max-w-full min-w-0 truncate text-xs font-semibold"
		title={text}
		data-testid="approval-mark">{text}</span
	>
{/if}
