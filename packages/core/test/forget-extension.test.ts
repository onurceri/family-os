import { sql } from 'kysely';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { forgetExtension } from '../src/forget-extension.ts';
import { createTestKernel, type TestKernel } from './harness.ts';

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel();
});
afterEach(() => k.close());

const NOW = 1_700_000_000_000;

it('removes what the host keeps about an extension and leaves the rest', async () => {
	const db = k.ctx.db;
	await sql`insert into core_drafts (id, action_id, input, status, proposed_by, created_at, updated_at)
		values ('drf_1', 'pets.addPet', '{}', 'pending', '{}', ${NOW}, ${NOW}),
			('drf_2', 'lists.addItem', '{}', 'pending', '{}', ${NOW}, ${NOW})`.execute(db);
	await sql`insert into core_settings (key, value, updated_at)
		values ('ai_areas', ${JSON.stringify({ pets: 'off', kitchen: 'local' })}, ${NOW})
		on conflict (key) do update set value = excluded.value`.execute(db);

	const forgotten = await forgetExtension(db, 'pets', NOW + 1);

	expect(forgotten.rows).toEqual({ drafts: 1 });
	expect(forgotten.settings).toEqual(['AI areas']);
	const left = await sql<{ id: string }>`select id from core_drafts`.execute(db);
	expect(left.rows).toEqual([{ id: 'drf_2' }]);
	const areas = await sql<{ value: string }>`select value from core_settings
		where key = 'ai_areas'`.execute(db);
	expect(JSON.parse(areas.rows[0]?.value ?? '{}')).toEqual({ kitchen: 'local' });
});
