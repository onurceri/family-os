import { openDatabase, runMigrations } from '@famos/db';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { coreMigrations, m0001_init } from '../src/migrations/0001_init.ts';

/** A fresh database gets core's constraints: checks, unique keys, foreign keys and cascades. */
it('a fresh database migrates with core constraints in place', async () => {
	const { db } = openDatabase({ path: ':memory:' });
	await runMigrations(db, [{ scope: 'core', migrations: coreMigrations }]);
	await sql`insert into core_members (id, display_name, role_id, color, created_at, updated_at) values ('member_a', 'A', 'admin', '#000000', 1, 1)`.execute(
		db,
	);

	const draft = (id: string, status: string, dedupe: string | null) =>
		sql`insert into core_drafts (id, action_id, input, status, proposed_by, dedupe_key, created_at, updated_at)
			values (${id}, 'x.y', '{}', ${status}, '{}', ${dedupe}, 1, 1)`.execute(db);
	for (const [i, status] of [
		'pending',
		'approved',
		'rejected',
		'applied',
		'failed',
		'undone',
		'expired',
	].entries())
		await draft(`draft_${i}`, status, null);
	await expect(draft('draft_x', 'nonsense', null)).rejects.toThrow(/CHECK/);
	await draft('draft_k1', 'pending', 'k1');
	await expect(draft('draft_k2', 'pending', 'k1')).rejects.toThrow(/UNIQUE/);
	const flags = await sql<{
		auto_approved: number;
		for_member: string | null;
	}>`select auto_approved, for_member from core_drafts where id = 'draft_k1'`.execute(db);
	expect(flags.rows).toEqual([{ auto_approved: 0, for_member: null }]);

	await sql`insert into core_audit_log (at, actor, action_id, outcome) values (1, '{}', 'x.y', 'undone')`.execute(
		db,
	);
	await expect(
		sql`insert into core_audit_log (at, actor, action_id, outcome) values (1, '{}', 'x.y', 'nonsense')`.execute(
			db,
		),
	).rejects.toThrow(/CHECK/);

	await sql`insert into core_devices (id, name, kind, token_hash, created_by, created_at, last_seen_at)
		values ('device_1', 'Tablet', 'family', 'h1', 'member_a', 1, 1)`.execute(db);
	const devices = await sql<{
		display_show_names: number;
	}>`select display_show_names from core_devices`.execute(db);
	expect(devices.rows).toEqual([{ display_show_names: 0 }]);
	await sql`insert into core_display_pairings (id, device_code_hash, user_code, expires_at, status, created_at)
		values ('p1', 'x', 'ABCD-EFGH', 2, 'pending', 1)`.execute(db);
	await expect(
		sql`update core_display_pairings set status = 'nonsense'`.execute(db),
	).rejects.toThrow(/CHECK/);

	// Repeated notifications collapse per member; rows without a key never collide.
	const notify = (id: string, member: string, dedupe: string | null) =>
		sql`insert into core_notifications (id, member_id, kind, title_key, dedupe_key, created_at)
			values (${id}, ${member}, 'x.y', 'app:t', ${dedupe}, 1)`.execute(db);
	await notify('notification_1', 'member_a', 'k1');
	await expect(notify('notification_2', 'member_a', 'k1')).rejects.toThrow(/UNIQUE/);
	await notify('notification_3', 'member_a', null);
	await notify('notification_4', 'member_a', null);
	await expect(notify('notification_5', 'member_zzz', 'k2')).rejects.toThrow(/FOREIGN KEY/);

	// Handles go with their token.
	const token = (id: string, hash: string, member = 'member_a', scope = 'read') =>
		sql`insert into core_api_tokens (id, member_id, name, token_hash, scope, created_at)
			values (${id}, ${member}, 'T', ${hash}, ${scope}, 1)`.execute(db);
	await token('api_token_1', 'h1');
	await expect(token('api_token_2', 'h1')).rejects.toThrow(/UNIQUE/);
	await expect(token('api_token_3', 'h3', 'member_zzz')).rejects.toThrow(/FOREIGN KEY/);
	await expect(token('api_token_4', 'h4', 'member_a', 'admin')).rejects.toThrow(/CHECK/);
	await sql`insert into core_api_token_handles (token_id, handle, ref_id, created_at) values ('api_token_1', 'vehicle:aa', 'vehicle_x', 1)`.execute(
		db,
	);
	await sql`delete from core_api_tokens`.execute(db);
	const left = await sql<{ n: number }>`select count(*) as n from core_api_token_handles`.execute(
		db,
	);
	expect(left.rows[0]?.n).toBe(0);

	// An idempotency key is unique per member.
	const idem = (member: string, key: string) =>
		sql`insert into core_idempotency (key, member_id, action_id, status, response, created_at)
			values (${key}, ${member}, 'x.y', 200, '{}', 1)`.execute(db);
	await idem('member_a', 'k1');
	await idem('member_b', 'k1');
	await expect(idem('member_a', 'k1')).rejects.toThrow(/UNIQUE|PRIMARY/);

	// One embedding row per chunk; vectors are stored as float32 bytes.
	const chunk = (id: string, index: number) =>
		sql`insert into core_embeddings (id, extension_id, source_kind, source_id, capability, title, href, snippet, model, dimensions, text_hash, chunk_index, vector, updated_at)
			values (${id}, 'kitchen', 'kitchen.recipe', 'recipe_1', 'kitchen.view', 'T', '/kitchen', 's', 'm', 2, 'h', ${index}, x'0000803f00000000', 1)`.execute(
			db,
		);
	await chunk('e1', 0);
	await chunk('e2', 1);
	await expect(chunk('e3', 1)).rejects.toThrow(/UNIQUE/);
	const stored = await sql<{
		vector: Uint8Array;
	}>`select vector from core_embeddings where id = 'e1'`.execute(db);
	expect([...new Float32Array(new Uint8Array(stored.rows[0]?.vector ?? []).buffer)]).toEqual([
		1, 0,
	]);

	// Tables are STRICT.
	await expect(
		sql`insert into core_member_memory (id, member_id, text, source, created_at, updated_at)
			values ('memory_1', 'member_a', 'x', 'member', 'not a number', 1)`.execute(db),
	).rejects.toThrow(/cannot store TEXT/i);
});

/** A database from before drafts could change their action keeps its drafts and audit log. */
it('upgrades the audit log and drafts so a draft can become another action', async () => {
	const { db } = openDatabase({ path: ':memory:' });
	await runMigrations(db, [{ scope: 'core', migrations: { '0001_init': m0001_init } }]);
	await sql`insert into core_drafts (id, action_id, input, status, proposed_by, created_at, updated_at)
		values ('draft_old', 'x.y', '{}', 'pending', '{}', 1, 1)`.execute(db);
	await sql`insert into core_audit_log (at, actor, action_id, draft_id, outcome)
		values (5, '{"kind":"system"}', 'x.y', 'draft_old', 'drafted')`.execute(db);

	await runMigrations(db, [{ scope: 'core', migrations: coreMigrations }]);

	const drafts = await sql<{
		replaced: string | null;
	}>`select replaced from core_drafts`.execute(db);
	expect(drafts.rows).toEqual([{ replaced: null }]);
	const audit = await sql<{
		id: number;
		at: number;
		outcome: string;
	}>`select id, at, outcome from core_audit_log`.execute(db);
	expect(audit.rows).toEqual([{ id: 1, at: 5, outcome: 'drafted' }]);
	await sql`insert into core_audit_log (at, actor, action_id, draft_id, outcome)
		values (6, '{}', 'x.y', 'draft_old', 'replaced')`.execute(db);
	await expect(
		sql`insert into core_audit_log (at, actor, action_id, outcome) values (1, '{}', 'x.y', 'nonsense')`.execute(
			db,
		),
	).rejects.toThrow(/CHECK/);
	const ids = await sql<{ id: number }>`select id from core_audit_log order by id`.execute(db);
	expect(ids.rows.map((r) => r.id)).toEqual([1, 2]);
	const index = await sql<{
		name: string;
	}>`select name from sqlite_schema where type = 'index' and tbl_name = 'core_audit_log'`.execute(
		db,
	);
	expect(index.rows.map((r) => r.name)).toContain('core_audit_log_at_idx');
});
