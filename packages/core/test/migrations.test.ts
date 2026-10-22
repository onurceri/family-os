import { openDatabase, runMigrations } from '@famos/db';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { coreMigrations, m0001_init, m0002_draft_replaced } from '../src/migrations/0001_init.ts';

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

/** Keys stored before principals existed keep working and stay the member's. */
it('adds a principal to idempotency answers and keeps the old rows', async () => {
	const { db } = openDatabase({ path: ':memory:' });
	const before = Object.fromEntries(
		Object.entries(coreMigrations).filter(
			([name]) =>
				name !== '0006_idempotency_principal' &&
				name !== '0007_changes' &&
				name !== '0008_connected_apps' &&
				name !== '0009_audit_target' &&
				name !== '0010_oauth',
		),
	);
	await runMigrations(db, [{ scope: 'core', migrations: before }]);
	await sql`insert into core_idempotency (key, member_id, action_id, status, response, created_at)
		values ('k', 'member_a', 'x.y', 200, '{}', 1)`.execute(db);
	await runMigrations(db, [{ scope: 'core', migrations: coreMigrations }]);
	const rows = await sql<{
		member_id: string;
		principal: string | null;
	}>`select member_id, principal from core_idempotency`.execute(db);
	expect(rows.rows).toEqual([{ member_id: 'member_a', principal: null }]);
});

/** AI actors stored before they said how they work get the mode their source had. */
it('gives stored AI actors their mode and marks memories the AI proposed', async () => {
	const { db } = openDatabase({ path: ':memory:' });
	await runMigrations(db, [
		{
			scope: 'core',
			migrations: { '0001_init': m0001_init, '0002_draft_replaced': m0002_draft_replaced },
		},
	]);
	await sql`insert into core_members (id, display_name, role_id, color, created_at, updated_at) values ('member_a', 'A', 'admin', '#000000', 1, 1)`.execute(
		db,
	);
	const actors = {
		draft_inbox: { kind: 'ai', source: 'inbox', onBehalfOf: 'member_a' },
		draft_thread: { kind: 'ai', source: 'assistant', sourceId: 't1', onBehalfOf: 'member_a' },
		draft_mcp: { kind: 'ai', source: 'mcp', onBehalfOf: 'member_a' },
		draft_member: { kind: 'member', memberId: 'member_a', roleId: 'admin' },
	};
	for (const [id, actor] of Object.entries(actors)) {
		await sql`insert into core_drafts (id, action_id, input, status, proposed_by, created_at, updated_at)
			values (${id}, 'x.y', '{}', 'pending', ${JSON.stringify(actor)}, 1, 1)`.execute(db);
		await sql`insert into core_audit_log (at, actor, action_id, draft_id, outcome)
			values (1, ${JSON.stringify(actor)}, 'x.y', ${id}, 'drafted')`.execute(db);
	}
	for (const [id, source] of [
		['memory_1', 'assistant'],
		['memory_2', 'member'],
	])
		await sql`insert into core_member_memory (id, member_id, text, source, created_at, updated_at)
			values (${id}, 'member_a', 'x', ${source}, 1, 1)`.execute(db);

	await runMigrations(db, [{ scope: 'core', migrations: coreMigrations }]);

	const drafts = await sql<{
		id: string;
		proposed_by: string;
	}>`select id, proposed_by from core_drafts order by id`.execute(db);
	const modes = Object.fromEntries(
		drafts.rows.map((r) => [r.id, (JSON.parse(r.proposed_by) as { mode?: string }).mode]),
	);
	expect(modes).toEqual({
		draft_inbox: 'share',
		draft_mcp: 'agent',
		draft_member: undefined,
		draft_thread: 'conversation',
	});
	expect(JSON.parse(drafts.rows.find((r) => r.id === 'draft_thread')?.proposed_by ?? '')).toEqual({
		...actors.draft_thread,
		mode: 'conversation',
	});
	const audit = await sql<{
		actor: string;
	}>`select actor from core_audit_log where draft_id = 'draft_inbox'`.execute(db);
	expect(JSON.parse(audit.rows[0]?.actor ?? '')).toMatchObject({ mode: 'share' });
	const memories = await sql<{
		source: string;
	}>`select source from core_member_memory order by id`.execute(db);
	expect(memories.rows.map((r) => r.source)).toEqual(['ai', 'member']);
});

/** Connected apps are new tables: personal keys and members from before stay as they were. */
it('adds connected apps beside the personal keys that already exist', async () => {
	const { db } = openDatabase({ path: ':memory:' });
	const before = Object.fromEntries(
		Object.entries(coreMigrations).filter(
			([name]) =>
				name !== '0008_connected_apps' && name !== '0009_audit_target' && name !== '0010_oauth',
		),
	);
	await runMigrations(db, [{ scope: 'core', migrations: before }]);
	await sql`insert into core_members (id, display_name, role_id, color, created_at, updated_at) values ('member_a', 'A', 'admin', '#000000', 1, 1)`.execute(
		db,
	);
	await sql`insert into core_api_tokens (id, member_id, name, token_hash, scope, created_at)
		values ('api_token_1', 'member_a', 'Claude', 'h1', 'read', 1)`.execute(db);
	await runMigrations(db, [{ scope: 'core', migrations: coreMigrations }]);
	const old = await sql<{
		id: string;
		scope: string;
	}>`select id, scope from core_api_tokens`.execute(db);
	expect(old.rows).toEqual([{ id: 'api_token_1', scope: 'read' }]);
	await sql`insert into core_apps (id, name, role_id, mode, created_at, updated_at)
		values ('app_1', 'HA', 'member', 'apply', 1, 1)`.execute(db);
	const app = await sql<{
		acts_for: string;
		paused_at: number | null;
	}>`select acts_for, paused_at from core_apps`.execute(db);
	expect(app.rows).toEqual([{ acts_for: '[]', paused_at: null }]);
	await expect(
		sql`insert into core_apps (id, name, role_id, mode, created_at, updated_at) values ('app_2', 'X', 'member', 'nonsense', 1, 1)`.execute(
			db,
		),
	).rejects.toThrow(/CHECK/);
	await sql`insert into core_app_tokens (id, app_id, name, token_hash, created_at) values ('t1', 'app_1', 'k', 'x', 1)`.execute(
		db,
	);
	await expect(
		sql`insert into core_app_tokens (id, app_id, name, token_hash, created_at) values ('t2', 'app_1', 'k', 'x', 1)`.execute(
			db,
		),
	).rejects.toThrow(/UNIQUE/);
});

/**
 * The audit log of the release before audit rows named their target keeps every row as it was
 * (with no target); rows written after the upgrade can name one.
 */
it('lets audit rows name their target and keeps the rows from before', async () => {
	const { db } = openDatabase({ path: ':memory:' });
	const before = Object.fromEntries(
		Object.entries(coreMigrations).filter(
			([name]) => name !== '0009_audit_target' && name !== '0010_oauth',
		),
	);
	await runMigrations(db, [{ scope: 'core', migrations: before }]);
	await sql`insert into core_audit_log (at, actor, action_id, draft_id, outcome)
		values (5, '{"kind":"system","source":"test"}', 'core.createMember', null, 'applied')`.execute(
		db,
	);
	await runMigrations(db, [{ scope: 'core', migrations: coreMigrations }]);
	await sql`insert into core_audit_log (at, actor, action_id, outcome, target)
		values (6, '{"kind":"system","source":"test"}', 'core.pauseApp', 'applied', 'app_1')`.execute(
		db,
	);
	const rows = await sql<{
		at: number;
		action_id: string;
		outcome: string;
		target: string | null;
	}>`select at, action_id, outcome, target from core_audit_log order by id`.execute(db);
	expect(rows.rows).toEqual([
		{ at: 5, action_id: 'core.createMember', outcome: 'applied', target: null },
		{ at: 6, action_id: 'core.pauseApp', outcome: 'applied', target: 'app_1' },
	]);
	const index = await sql<{
		name: string;
	}>`select name from sqlite_master where type = 'index' and tbl_name = 'core_audit_log'`.execute(
		db,
	);
	expect(index.rows.map((r) => r.name)).toContain('core_audit_log_at_idx');
});

/**
 * The release before AI apps could sign in keeps its keys as they were; they are not grants of
 * an app. Rows written after the upgrade link a grant to its app, and a grant takes its
 * secrets, codes and handles with it when it goes.
 */
it('adds sign-in for AI apps and keeps the keys from before', async () => {
	const { db } = openDatabase({ path: ':memory:' });
	const before = Object.fromEntries(
		Object.entries(coreMigrations).filter(([name]) => name !== '0010_oauth'),
	);
	await runMigrations(db, [{ scope: 'core', migrations: before }]);
	await sql`insert into core_members (id, display_name, role_id, color, created_at, updated_at) values ('member_a', 'A', 'admin', '#000000', 1, 1)`.execute(
		db,
	);
	await sql`insert into core_api_tokens (id, member_id, name, token_hash, scope, expires_at, created_at)
		values ('api_token_old', 'member_a', 'Laptop', 'hash_old', 'read', 99, 1)`.execute(db);

	await runMigrations(db, [{ scope: 'core', migrations: coreMigrations }]);

	const old = await sql<{
		id: string;
		token_hash: string;
		expires_at: number;
		oauth_client_id: string | null;
	}>`select id, token_hash, expires_at, oauth_client_id from core_api_tokens`.execute(db);
	expect(old.rows).toEqual([
		{ id: 'api_token_old', token_hash: 'hash_old', expires_at: 99, oauth_client_id: null },
	]);

	const client = (id: string, kind: string, pkce = 1, clientId = id) =>
		sql`insert into core_oauth_clients (id, kind, client_id, name, redirect_uris, require_pkce, created_at)
			values (${id}, ${kind}, ${clientId}, 'App', '[]', ${pkce}, 1)`.execute(db);
	await client('c1', 'registered', 0);
	await client('c2', 'dynamic');
	await expect(client('c3', 'unknown')).rejects.toThrow(/CHECK/);
	await expect(client('c4', 'metadata', 0)).rejects.toThrow(/CHECK/);
	await expect(client('c5', 'dynamic', 2)).rejects.toThrow(/CHECK/);
	await expect(client('c6', 'dynamic', 1, 'c2')).rejects.toThrow(/UNIQUE/);

	await sql`insert into core_api_tokens (id, member_id, name, token_hash, scope, created_at, oauth_client_id)
		values ('api_token_new', 'member_a', 'App', 'oauth:api_token_new', 'read', 1, 'c2')`.execute(
		db,
	);
	await expect(
		sql`insert into core_api_tokens (id, member_id, name, token_hash, scope, created_at, oauth_client_id)
			values ('api_token_bad', 'member_a', 'App', 'oauth:x', 'read', 1, 'nobody')`.execute(db),
	).rejects.toThrow(/FOREIGN KEY/);
	await sql`insert into core_oauth_requests (id, client_row_id, redirect_uri, scope_requested, resource, created_at, expires_at)
		values ('r1', 'c2', 'https://x.example/cb', 'familyos.read', 'https://f.example/mcp', 1, 2)`.execute(
		db,
	);
	await expect(
		sql`update core_oauth_requests set decision = 'maybe' where id = 'r1'`.execute(db),
	).rejects.toThrow(/CHECK/);
	await sql`insert into core_oauth_codes (code_hash, request_id, grant_id, expires_at, created_at)
		values ('h1', 'r1', 'api_token_new', 2, 1)`.execute(db);
	await sql`insert into core_oauth_tokens (id, grant_id, kind, token_hash, resource, expires_at, created_at)
		values ('t1', 'api_token_new', 'access', 'th1', 'https://f.example/mcp', 2, 1)`.execute(db);
	await expect(
		sql`insert into core_oauth_tokens (id, grant_id, kind, token_hash, resource, expires_at, created_at)
			values ('t2', 'api_token_new', 'access', 'th1', 'https://f.example/mcp', 2, 1)`.execute(db),
	).rejects.toThrow(/UNIQUE/);
	await expect(
		sql`insert into core_oauth_tokens (id, grant_id, kind, token_hash, resource, expires_at, created_at)
			values ('t3', 'api_token_new', 'id', 'th3', 'https://f.example/mcp', 2, 1)`.execute(db),
	).rejects.toThrow(/CHECK/);
	await expect(
		sql`insert into core_oauth_tokens (id, grant_id, kind, token_hash, resource, expires_at, created_at)
			values ('t4', 'api_token_new', 'access', 'th4', 'https://f.example/mcp', 'soon', 1)`.execute(
			db,
		),
	).rejects.toThrow(/cannot store TEXT/i);

	await sql`delete from core_api_tokens where id = 'api_token_new'`.execute(db);
	const left = await sql<{
		n: number;
	}>`select (select count(*) from core_oauth_tokens) + (select count(*) from core_oauth_codes) as n`.execute(
		db,
	);
	expect(left.rows[0]?.n).toBe(0);
});
