import { systemActor } from '@famos/sdk';
import { createTestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { describe, expect, it } from 'vitest';
import { bundledExtensions } from '../eval/household.ts';

/** What the page reads of a card. */
interface Card {
	id: string;
	actionId: string;
	input: Record<string, unknown>;
	editedInput: unknown;
}

/**
 * Found in use over four rounds: a change made on a Quick add card lived in the browser, so a
 * reload, another device or a second admin lost it. The edit is the server's now (`core.editDraft`),
 * and this follows it the way a family does: a message is read, one person edits a card, the page
 * is loaded again, and another admin approves what is stored.
 */
describe('edit, reload, approve', () => {
	it('keeps an edit made on a card for the reload, for the second admin who approves it and for the member behind it', async () => {
		const k = await createTestKernel({ extensions: await bundledExtensions() });
		try {
			await k.runner.invoke(
				'core.updateFamilySettings',
				{ timeZone: 'UTC', locale: 'en', formatLocale: 'en-GB' },
				systemActor('test'),
			);
			k.clock.set(epochOf('2026-10-06', '10:00', 'UTC'));
			const tom = await k.member('admin', 'Tom');
			const mara = await k.member('admin', 'Mara');
			// A supervised member's suggestions go to the approvers (an admin's own stay theirs).
			const ivy = await k.member('supervised', 'Ivy');
			k.llm.respond({
				label: 'Trip to Bled',
				intent: 'actionable',
				mentions: [
					{
						kind: 'calendar.event',
						title: 'Class trip to Bled',
						date: { text: 'Friday 6 November', day: 6, month: 11, weekday: 5 },
						time: '07:40',
						timeText: '7:40',
						quote: 'our class trip to Bled is on Friday 6 November. The bus leaves school at 7:40',
					},
				],
			});
			const item = await k.route('inbox.createItem').call({
				body: {
					channel: 'share',
					text: 'Our class trip to Bled is on Friday 6 November. The bus leaves school at 7:40.',
				},
				files: [],
				actor: ivy.actor,
			});
			await k.worker.drain();
			const list = (who: typeof tom) =>
				k.route('core.listDrafts').call({
					query: { sourceId: item.id, limit: 50 },
					actor: who.actor,
				});
			const [card] = (await list(tom)).filter((d: Card) => d.actionId === 'calendar.createEvent');
			if (!card) throw new Error('expected the trip as a card');
			expect(card.editedInput).toBeNull();

			// Tom, an approver, edits the title and the end time and saves.
			const edited = { ...card.input, title: 'Class 4B trip to Bled', endTime: '16:00' };
			await k.runner.invoke('core.editDraft', { draftId: card.id, input: edited }, tom.actor);

			// A reload, the other admin's page and the child's own read the same stored edit.
			for (const who of [tom, mara, ivy]) {
				const again = (await list(who)).find((d: Card) => d.id === card.id);
				expect(again).toMatchObject({ status: 'pending', input: card.input, editedInput: edited });
			}

			// Mara approves without sending anything: what was stored is what is added.
			const done = await k.runner.approveDraft(card.id, mara.actor);
			expect(done.status).toBe('applied');
			const day = await k.route('calendar.listOccurrences').call({
				query: { from: '2026-11-06', to: '2026-11-06' },
				actor: mara.actor,
			});
			expect(day.map((o: { title: string }) => o.title)).toEqual(['Class 4B trip to Bled']);
			expect((await list(tom)).find((d: Card) => d.id === card.id)).toMatchObject({
				status: 'applied',
				editedInput: edited,
			});
		} finally {
			await k.close();
		}
	});
});
