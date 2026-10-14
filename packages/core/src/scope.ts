import {
	type DbExecutor,
	type ExtensionFiles,
	type ExtensionManifest,
	type ExternalHttp,
	FamosError,
	type FileStore,
} from '@famos/sdk';
import { type KyselyPlugin, type OperationNode, type RootOperationNode, sql } from 'kysely';
import type { CoreTables } from './tables.ts';

/**
 * The names of everything in the database schema (tables, views, indexes, triggers), lower-cased.
 * Raw SQL is text, so it is checked against these: a word in it that names another extension's
 * table is refused. Read again before each extension's migrations and when the kernel starts.
 */
export interface SchemaNames {
	current(): ReadonlySet<string>;
	refresh(db: DbExecutor): Promise<void>;
}

export function createSchemaNames(): SchemaNames {
	let names: ReadonlySet<string> = new Set();
	return {
		current: () => names,
		async refresh(db) {
			const rows = await sql<{ name: string }>`select name from sqlite_master`.execute(db);
			names = new Set(rows.rows.map((r) => r.name.toLowerCase()));
		},
	};
}

/** Words of raw SQL that reach past an extension's own tables whatever they name. */
const RAW_BEYOND = /^(sqlite_|pragma)|^(attach|detach)$/;
const WORD = /[A-Za-z_][A-Za-z0-9_$]*/g;

interface Check {
	readonly id: string;
	readonly prefix: string;
	readonly names: ReadonlySet<string>;
	/** Table names that did not carry the prefix: allowed only as names the query defines. */
	unprefixed: string[] | null;
	/** Aliases and common table expressions of the query, lower-cased. */
	defined: string[] | null;
}

const refuse = (check: Check, what: string): never => {
	throw new FamosError(
		'forbidden',
		`Extension "${check.id}" may only use its own tables (named "${check.prefix}…"), not ${what}. ` +
			'Reach another extension through an action listed in famos.calls of its package.json, ' +
			'and members and family settings through ctx.family.',
	);
};

function checkName(check: Check, name: string, what: string): void {
	if (!name.toLowerCase().startsWith(check.prefix)) refuse(check, `${what} "${name}"`);
}

function checkSchemable(
	check: Check,
	node: { schema?: { name: string }; identifier: { name: string } },
	what: string,
): void {
	if (node.schema) refuse(check, `${what} in schema "${node.schema.name}"`);
	checkName(check, node.identifier.name, what);
}

function checkTable(
	check: Check,
	node: { table: { schema?: { name: string }; identifier: { name: string } } },
) {
	const { schema, identifier } = node.table;
	if (schema) refuse(check, `table "${schema.name}.${identifier.name}"`);
	if (identifier.name.toLowerCase().startsWith(check.prefix)) return;
	// An alias (`lists_items as i`, then `i.title`) or a common table expression is named by the
	// query itself; checked once all of it is seen.
	check.unprefixed ??= [];
	check.unprefixed.push(identifier.name);
}

function checkRawWord(check: Check, word: string): void {
	const lower = word.toLowerCase();
	if (RAW_BEYOND.test(lower)) refuse(check, `"${word}" in raw SQL`);
	if (check.names.has(lower) && !lower.startsWith(check.prefix))
		refuse(check, `table "${word}" in raw SQL`);
}

/** A name the query gives something; it must not stand in for another extension's table. */
function define(check: Check, name: string): void {
	const lower = name.toLowerCase();
	if (check.names.has(lower) && !lower.startsWith(check.prefix))
		refuse(check, `the name "${name}", which is another table's`);
	check.defined ??= [];
	check.defined.push(lower);
}

/** Visits every node of a query once, without copying it; values are never entered. */
function visit(check: Check, node: OperationNode, checkedRaw: WeakSet<object>): void {
	switch (node.kind) {
		case 'ValueNode':
		case 'PrimitiveValueListNode':
		case 'DefaultInsertValueNode':
			return;
		case 'TableNode':
			checkTable(check, node as unknown as Parameters<typeof checkTable>[1]);
			return;
		case 'CommonTableExpressionNameNode':
			define(
				check,
				(node as unknown as { table: { table: { identifier: { name: string } } } }).table.table
					.identifier.name,
			);
			return;
		case 'AliasNode': {
			const alias = (node as unknown as { alias: OperationNode }).alias;
			if (alias.kind === 'IdentifierNode')
				define(check, (alias as unknown as { name: string }).name);
			break;
		}
		case 'RawNode': {
			const raw = node as unknown as {
				sqlFragments: readonly string[];
				parameters: readonly OperationNode[];
			};
			// A template's fragments are one frozen array per call site: checked once.
			if (!checkedRaw.has(raw.sqlFragments)) {
				for (const fragment of raw.sqlFragments)
					for (const [word] of fragment.matchAll(WORD)) checkRawWord(check, word);
				checkedRaw.add(raw.sqlFragments);
			}
			for (const parameter of raw.parameters) {
				// `sql.id(...)` puts a bare name into the text.
				if (parameter.kind === 'IdentifierNode')
					checkRawWord(check, (parameter as unknown as { name: string }).name);
				else if (parameter.kind === 'SchemableIdentifierNode') {
					const id = parameter as unknown as {
						schema?: { name: string };
						identifier: { name: string };
					};
					if (id.schema) refuse(check, `schema "${id.schema.name}" in raw SQL`);
					checkRawWord(check, id.identifier.name);
				} else visit(check, parameter, checkedRaw);
			}
			return;
		}
		case 'CreateIndexNode':
			checkName(check, (node as unknown as { name: { name: string } }).name.name, 'index');
			break;
		case 'DropIndexNode':
		case 'CreateViewNode':
		case 'DropViewNode':
			checkSchemable(
				check,
				(node as unknown as { name: Parameters<typeof checkSchemable>[1] }).name,
				node.kind === 'DropIndexNode' ? 'index' : 'view',
			);
			break;
	}
	const record = node as unknown as Record<string, unknown>;
	for (const key in record) {
		if (key === 'kind') continue;
		const value = record[key];
		if (value === null || typeof value !== 'object') continue;
		if (Array.isArray(value)) {
			for (const item of value)
				if (item !== null && typeof item === 'object' && 'kind' in item)
					visit(check, item as OperationNode, checkedRaw);
		} else if ('kind' in value) visit(check, value as OperationNode, checkedRaw);
	}
}

/** Throws `forbidden` when a query reaches past the tables with this prefix. */
export function checkScope(
	id: string,
	prefix: string,
	names: ReadonlySet<string>,
	node: RootOperationNode,
	checkedRaw: WeakSet<object> = new WeakSet(),
): void {
	const check: Check = { id, prefix, names, unprefixed: null, defined: null };
	visit(check, node, checkedRaw);
	if (check.unprefixed === null) return;
	for (const name of check.unprefixed)
		if (!check.defined?.includes(name.toLowerCase())) refuse(check, `table "${name}"`);
}

/**
 * A Kysely plugin that keeps an extension to its own tables: any table, index or view outside
 * its prefix, in queries and DDL alike, and raw SQL that names another extension's table or the
 * schema itself (`sqlite_master`, `pragma`), throws `forbidden` before the query runs. The query
 * is only read, never rebuilt. `trx.withPlugin(...)` keeps the transaction.
 */
export function scopePlugin(id: string, prefix: string, names: SchemaNames): KyselyPlugin {
	let checkedRaw = new WeakSet<object>();
	let seen = names.current();
	return {
		transformQuery({ node }) {
			const current = names.current();
			// A fragment passed against an older schema is checked again against the new one.
			if (current !== seen) {
				seen = current;
				checkedRaw = new WeakSet();
			}
			checkScope(id, prefix, current, node, checkedRaw);
			return node;
		},
		transformResult: async ({ result }) => result,
	};
}

/** Whether a file key belongs to an extension: it lies under `<id>/`. */
const ownsKey = (extensionId: string, key: string) => key.startsWith(`${extensionId}/`);

/**
 * The file store as one extension sees it: it writes and deletes only under `<id>/`, and reads
 * those keys and the ones granted to it in `core_file_grants`. Grants are read and written
 * through `db`, so inside a unit of work they belong to its transaction.
 */
export function scopedFiles(
	store: FileStore,
	extensionId: string,
	db: DbExecutor,
	now: () => number,
): ExtensionFiles {
	const grants = () => db.withTables<CoreTables>();
	const writable = (key: string, what: string) => {
		if (!ownsKey(extensionId, key))
			throw new FamosError(
				'forbidden',
				`Extension "${extensionId}" may only ${what} files under "${extensionId}/", not "${key}"`,
			);
	};
	const readable = async (key: string) => {
		if (ownsKey(extensionId, key)) return true;
		const row = await grants()
			.selectFrom('core_file_grants')
			.select('key')
			.where('key', '=', key)
			.where('grantee', '=', extensionId)
			.executeTakeFirst();
		return row !== undefined;
	};
	return {
		async put(key, data, contentType) {
			writable(key, 'write');
			return store.put(key, data, contentType);
		},
		async delete(key) {
			writable(key, 'delete');
			return store.delete(key);
		},
		async get(key) {
			return (await readable(key)) ? store.get(key) : null;
		},
		async stat(key) {
			return (await readable(key)) ? store.stat(key) : null;
		},
		async grant(key, toExtension) {
			writable(key, 'grant');
			if (toExtension === extensionId) return;
			await grants()
				.insertInto('core_file_grants')
				.values({ key, grantee: toExtension, created_at: now() })
				.onConflict((oc) => oc.doNothing())
				.execute();
		},
	};
}

/** The whole file store, for the host and core: every key, and grants on any of them. */
export function hostFiles(store: FileStore, db: DbExecutor, now: () => number): ExtensionFiles {
	return {
		put: (key, data, contentType) => store.put(key, data, contentType),
		get: (key) => store.get(key),
		stat: (key) => store.stat(key),
		delete: (key) => store.delete(key),
		async grant(key, toExtension) {
			await db
				.withTables<CoreTables>()
				.insertInto('core_file_grants')
				.values({ key, grantee: toExtension, created_at: now() })
				.onConflict((oc) => oc.doNothing())
				.execute();
		},
	};
}

/**
 * Outbound HTTP as the manifest's `network` allows it: an extension that declares nothing
 * reaches nothing; `hosts` are the hosts it calls itself; `userUrls` lets it fetch any public
 * address a person typed; `local` lets a person allow an address on the home network.
 */
export function scopedHttp(http: ExternalHttp, manifest: ExtensionManifest): ExternalHttp {
	const network = manifest.network ?? {};
	const hosts = new Set((network.hosts ?? []).map((h) => h.toLowerCase()));
	const refuse = (what: string): never => {
		throw new FamosError(
			'forbidden',
			`Extension "${manifest.id}" may not reach ${what}: declare it in famos.network of its package.json`,
		);
	};
	return {
		async get(request) {
			if (request.allowLocal && network.local !== true) refuse('the home network');
			if (network.userUrls !== true) {
				let host: string;
				try {
					host = new URL(request.url.trim().replace(/^webcals?:/i, 'https:')).hostname;
				} catch {
					return refuse('an address that is not a URL');
				}
				if (!hosts.has(host.toLowerCase())) refuse(`"${host}"`);
			}
			return http.get(request);
		},
	};
}
