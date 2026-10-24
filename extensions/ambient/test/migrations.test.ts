import { openDatabase, runMigrations } from '@famos/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { migrations } from '../src/server/store.ts';

const { '0002_photo_file_unique': _unique, ...before } = migrations;

it('keeps the oldest photo of a file two photos shared, and refuses a new one', async () => {
	const { db } = openDatabase({ path: ':memory:' });
	await runMigrations(db, [{ scope: 'ambient', migrations: before }]);
	const insert = (id: string, key: string, at: number) =>
		sql`insert into ambient_photos (id, file_key, content_type, width, height, byte_size, uploaded_by, created_at)
			values (${id}, ${key}, 'image/png', 8, 6, 10, null, ${at})`.execute(db);
	await insert('amb_photo_b', 'ambient/photos/x.png', 5);
	await insert('amb_photo_a', 'ambient/photos/x.png', 5);
	await insert('amb_photo_c', 'ambient/photos/x.png', 9);
	await insert('amb_photo_d', 'ambient/photos/y.png', 7);

	await runMigrations(db, [{ scope: 'ambient', migrations }]);

	const rows = await sql<{ id: string }>`select id from ambient_photos order by id`.execute(db);
	expect(rows.rows.map((r) => r.id)).toEqual(['amb_photo_a', 'amb_photo_d']);
	await expect(insert('amb_photo_e', 'ambient/photos/y.png', 8)).rejects.toThrow();
});
