import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * Hand-written table types for core's tables. Keep in sync with core migrations;
 * test/schema.test.ts compares them against the migrated schema.
 * JSON columns are stored as TEXT and parsed at the edges.
 */
export type MembersTable = {
	id: string;
	display_name: string;
	/** A built-in role (`admin`, `member`, `supervised`, `guest`) or a `core_roles` id. */
	role_id: string;
	/** Free text about the person, for context (AI prompt); no security meaning. */
	about: string | null;
	color: string;
	locale: string | null;
	created_at: number;
	updated_at: number;
	archived_at: number | null;
};

/** A custom role: a built-in base plus capability overrides. */
export type RolesTable = {
	id: string;
	name: string;
	base: 'member' | 'supervised' | 'guest';
	/** JSON object: capability id → granted. */
	overrides: string;
	created_at: number;
	updated_at: number;
};

/**
 * `undone`: applied, then taken back with the action's inverse (Undo). `expired`: never decided,
 * and the day it was about has passed (it never runs).
 */
export type DraftStatus =
	| 'pending'
	| 'approved'
	| 'rejected'
	| 'applied'
	| 'failed'
	| 'undone'
	| 'expired';

export type DraftsTable = {
	id: string;
	action_id: string;
	/** JSON: the proposed, validated action input. */
	input: string;
	/** JSON: the input after human edits, if any. */
	edited_input: string | null;
	status: DraftStatus;
	/** JSON Actor that proposed the draft. */
	proposed_by: string;
	source_kind: string | null;
	source_id: string | null;
	summary: string | null;
	model: string | null;
	prompt_version: string | null;
	confidence: number | null;
	/** JSON array of input paths the proposer was unsure about. */
	uncertain_fields: string | null;
	/** The words of the shared message it rests on, as the message writes them. */
	quote: string | null;
	/** Makes drafting idempotent; unique where set. */
	dedupe_key: string | null;
	decided_by: string | null;
	decided_at: number | null;
	applied_at: number | null;
	/** JSON action output after applying. */
	result: string | null;
	error: string | null;
	/** Addressed to one member: only they see and decide it (memory). */
	for_member: string | null;
	/**
	 * JSON `{ actionId, input }`: what a pending draft proposed before a reviewer turned it into
	 * another action (`ActionDefinition.instead`). Null when it never changed.
	 */
	replaced: string | null;
	/** 1 when the auto-approval setting approved it (`decided_by` is who enabled the setting). */
	auto_approved: Generated<number>;
	created_at: number;
	updated_at: number;
};

export type AuditOutcome = 'applied' | 'drafted' | 'rejected' | 'undone' | 'replaced';

export type AuditLogTable = {
	id: Generated<number>;
	at: number;
	/** JSON Actor. */
	actor: string;
	action_id: string;
	draft_id: string | null;
	outcome: AuditOutcome;
};

export type SettingsTable = {
	key: string;
	/** JSON value. */
	value: string;
	updated_at: ColumnType<number, number, number>;
};

export type DevicesTable = {
	id: string;
	name: string;
	kind: 'family' | 'kiosk';
	/** SHA-256 (hex) of the device token; the token itself lives only in the device's cookie. */
	token_hash: string;
	created_by: string;
	created_at: number;
	last_seen_at: number;
	revoked_at: number | null;
	/** Displays only (kind `kiosk`): JSON array of the view capabilities it may use. */
	display_capabilities: string | null;
	/** Displays only: member names and colors may be shown (1) or not (0). */
	display_show_names: number;
};

/** Pairing a display by code (RFC 8628 style). Only the device code's hash is stored. */
export type DisplayPairingsTable = {
	id: string;
	device_code_hash: string;
	/** `XXXX-XXXX`, shown on the display and typed on a phone. */
	user_code: string;
	expires_at: number;
	/** Wrong codes typed since this pairing started; five end it. */
	attempts: number;
	status: 'pending' | 'confirmed' | 'consumed';
	/** What the admin chose when confirming; the device is created when the display collects it. */
	name: string | null;
	capabilities: string | null;
	show_names: number;
	confirmed_by: string | null;
	device_id: string | null;
	created_ip: string | null;
	created_at: number;
};

/** One row per recipient: the in-app record that channels copy. */
export type NotificationsTable = {
	id: string;
	member_id: string;
	kind: string;
	title_key: string;
	/** JSON object of interpolation parameters. */
	title_params: string | null;
	body_key: string | null;
	body_params: string | null;
	/** A path inside the app. */
	url: string | null;
	source_kind: string | null;
	source_id: string | null;
	/** Repeats collapse per member; unique where set. */
	dedupe_key: string | null;
	created_at: number;
	read_at: number | null;
};

export type NotificationPrefsTable = {
	member_id: string;
	/** JSON: `{ kinds: { [kind]: { [channel]: boolean } }, quietHours: { start, end } | null }`. */
	prefs: string;
	updated_at: number;
};

/** Personal API tokens. Only the SHA-256 (hex) of the token is stored. */
export type ApiTokensTable = {
	id: string;
	member_id: string;
	name: string;
	token_hash: string;
	/** `read`: read tools only; `read_write`: read tools and draft tools. */
	scope: 'read' | 'read_write';
	expires_at: number | null;
	last_used_at: number | null;
	created_at: number;
	revoked_at: number | null;
};

/** Which id a token was shown as which handle (MCP is stateless). */
export type ApiTokenHandlesTable = {
	token_id: string;
	handle: string;
	ref_id: string;
	created_at: number;
};

/** One thing that changed (see `m0007_changes`); `seq` is the cursor apps read by. */
export type ChangesTable = {
	seq: Generated<number>;
	at: number;
	extension: string;
	entity: string;
	entity_id: string;
	op: 'upsert' | 'delete';
	/** The event's audience, as JSON. */
	audience: string;
};

/** The stored result of a request with an `Idempotency-Key`. */
export type IdempotencyTable = {
	key: string;
	/**
	 * The owner half of the primary key: the member's id for a member, the principal itself for
	 * anyone else, so the two never meet.
	 */
	member_id: string;
	/** Who asked (`principalOf`, with the member an AI works for); null on rows from before it. */
	principal: string | null;
	action_id: string;
	/** HTTP status the first answer had (200, or a stored 400/403/404). */
	status: number;
	/** JSON: the action result, or `{ code, message, details }` for a stored error. */
	response: string;
	created_at: number;
};

/** A chunk of searchable text and its vector. */
export type EmbeddingsTable = {
	id: string;
	extension_id: string;
	source_kind: string;
	source_id: string;
	/** The capability the kind required when the chunk was written (informational). */
	capability: string;
	/** Set when only that member sees the entity (and holders of the kind's `viewAll`). */
	owner_member_id: string | null;
	title: string;
	/** A path inside the app. */
	href: string;
	/** The first characters of the chunk, shown in results. */
	snippet: string;
	/** The embedding model key (`<provider id>:<model>`). */
	model: string;
	dimensions: number;
	text_hash: string;
	chunk_index: number;
	/** float32, little-endian, unit length. */
	vector: Uint8Array;
	updated_at: number;
};

/** A short note a member owns; the AI sees it only in that member's own conversations. */
export type MemberMemoryTable = {
	id: string;
	member_id: string;
	text: string;
	source: 'member' | 'ai';
	created_at: number;
	updated_at: number;
};

/** A file of one extension that another may read (`key` lies under the owner's `<id>/`). */
export type FileGrantsTable = {
	key: string;
	/** The extension that may read it. */
	grantee: string;
	created_at: number;
};

export type CoreTables = {
	core_file_grants: FileGrantsTable;
	core_member_memory: MemberMemoryTable;
	core_idempotency: IdempotencyTable;
	core_changes: ChangesTable;
	core_embeddings: EmbeddingsTable;
	core_api_tokens: ApiTokensTable;
	core_api_token_handles: ApiTokenHandlesTable;
	core_members: MembersTable;
	core_roles: RolesTable;
	core_drafts: DraftsTable;
	core_audit_log: AuditLogTable;
	core_settings: SettingsTable;
	core_devices: DevicesTable;
	core_display_pairings: DisplayPairingsTable;
	core_notifications: NotificationsTable;
	core_notification_prefs: NotificationPrefsTable;
};

export type MemberRow = Selectable<MembersTable>;
export type NewMember = Insertable<MembersTable>;
export type MemberUpdate = Updateable<MembersTable>;
export type DraftRow = Selectable<DraftsTable>;
export type DeviceRow = Selectable<DevicesTable>;
export type ApiTokenRow = Selectable<ApiTokensTable>;
