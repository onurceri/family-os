import { createTestKernel } from '@famos/testing';
import { describe, expect, it } from 'vitest';
import { bundledExtensions } from '../eval/household.ts';

// The row a change works on (`target`) is read by the runner to tell a suggestion that can no
// longer be applied. A table or column that is misspelt would judge nothing, silently: every
// action that names one must name something its extension really has.
describe('the targets of the shipped actions', () => {
	it('name a table and a live column their extension has', async () => {
		const k = await createTestKernel({ extensions: await bundledExtensions() });
		try {
			const checked: string[] = [];
			for (const def of k.registry.actions.values()) {
				if (!def.target) continue;
				const owner = def.id.slice(0, def.id.indexOf('.'));
				// Every id field an action may name its target by.
				const target = def.target({ id: 'x', homeId: 'x', petId: 'x', vehicleId: 'x' });
				expect(target, def.id).not.toBeNull();
				if (!target) continue;
				const db = k.contextFor(owner).db.withTables<Record<string, Record<string, unknown>>>();
				let query = db.selectFrom(target.table).select('id').where('id', '=', 'x');
				if (target.liveColumn) query = query.where(target.liveColumn, 'is', null);
				await expect(query.execute(), def.id).resolves.toEqual([]);
				checked.push(def.id);
			}
			// Calendar, lists, kitchen, chores, home, pets, vehicles, records and board name theirs.
			expect(checked.length).toBeGreaterThan(30);
		} finally {
			await k.close();
		}
	});
});
