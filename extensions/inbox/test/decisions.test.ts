import { describe, expect, it } from 'vitest';
import { bundledExtensions } from '../eval/household.ts';

/*
 * A kind's resolver may settle a field the message does not write (the whole family when nobody
 * is named, a default list, a date from a weekday). The host marks those fields "check this", but
 * only for a kind that says which fields it settles. This holds every kind the app ships, and so
 * every kind added later, to declaring that, even if only as "none".
 */
describe('the decisions every mention kind declares', () => {
	it('are declared by every kind of every extension the app ships', async () => {
		const kinds = (await bundledExtensions()).flatMap((e) => e.ai?.kinds ?? []);
		expect(kinds.length).toBeGreaterThan(15);
		const missing = kinds.filter((kind) => kind.decides === undefined).map((kind) => kind.id);
		expect(missing, 'kinds that do not declare `decides`').toEqual([]);
	});

	it('name a field and one way to decide it', async () => {
		const kinds = (await bundledExtensions()).flatMap((e) => e.ai?.kinds ?? []);
		for (const kind of kinds)
			for (const [field, how] of Object.entries(kind.decides ?? {})) {
				expect(field, kind.id).toMatch(/^[A-Za-z][A-Za-z0-9]*(\.(\*|[A-Za-z0-9]+))*$/u);
				expect(['defaulted', 'inferred'], `${kind.id} ${field}`).toContain(how);
			}
	});

	it('cover the guesses the families met: whole family, default list, weekday, occurrence', async () => {
		const kinds = new Map(
			(await bundledExtensions()).flatMap((e) => e.ai?.kinds ?? []).map((k) => [k.id, k]),
		);
		expect(kinds.get('calendar.event')?.decides).toMatchObject({
			memberIds: 'defaulted',
			date: 'inferred',
		});
		expect(kinds.get('calendar.eventCancel')?.decides).toMatchObject({ occurrence: 'inferred' });
		expect(kinds.get('lists.shoppingItem')?.decides).toMatchObject({ listId: 'defaulted' });
	});
});
