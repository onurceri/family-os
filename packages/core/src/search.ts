import {
	type ActionResult,
	type Actor,
	type AiIndexKind,
	type Clock,
	type DbExecutor,
	defineAction,
	defineJob,
	defineRoute,
	type ExtensionContext,
	FamosError,
	type IdGenerator,
	isLlmError,
	type JobContext,
	type LlmEmbedResult,
	type LlmPort,
	type Logger,
	memberBehind,
	type SearchIndexer,
} from '@famos/sdk';
import { z } from 'zod';
import type { Access } from './access.ts';
import type { AiAreas } from './ai-areas.ts';
import { type Features, ownerOf } from './features.ts';
import type { Registry } from './registry.ts';
import type { CoreTables } from './tables.ts';

/**
 * Family search. Extensions describe their entities as plain text (`ai.index`);
 * `core.embed` cuts the text into chunks, embeds the ones that changed and stores the vectors in
 * `core_embeddings`. `core.searchFamily` embeds the question, loads the vectors the asker may
 * read (area and capability filters come first) and scores them in TypeScript. Chunk text, the
 * question and vectors are family content: they are never logged.
 */

export const EMBED_JOB = 'core.embed';
export const SYNC_JOB = 'core.embedSync';
export const REBUILD_JOB = 'core.embedRebuild';
export const SEARCH_ACTION = 'core.searchFamily';

/** The `feature` recorded in usage and switched in Settings → AI for query embeddings. */
const QUERY_FEATURE = 'search';
/** The `feature` of background indexing. */
const INDEX_FEATURE = 'search.index';

/** About this many characters per chunk, with a small overlap. */
export const CHUNK_CHARS = 800;
const CHUNK_OVERLAP = 100;
/** More than this is not indexed; the rest of a very long text is not worth the cost. */
const MAX_CHUNKS = 40;
const SNIPPET_CHARS = 240;
const EMBED_BATCH = 32;
const QUERY_TIMEOUT_MS = 10_000;
const INDEX_TIMEOUT_MS = 90_000;
const REBUILD_PAGE_PAUSE_MS = 0;
export const MAX_RESULTS = 10;

/* ───────────────────────── Text and vectors ───────────────────────── */

/** Plain text in pieces of about `CHUNK_CHARS`, cut at a paragraph, sentence or space. */
export function chunkText(text: string): string[] {
	const clean = text
		.replace(/\r\n?/g, '\n')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	if (clean === '') return [];
	const chunks: string[] = [];
	let start = 0;
	while (start < clean.length && chunks.length < MAX_CHUNKS) {
		let end = Math.min(clean.length, start + CHUNK_CHARS);
		if (end < clean.length) {
			const window = clean.slice(start, end);
			// Prefer a paragraph break, then a sentence end, then a space, in the last third.
			const floor = Math.floor(window.length * 0.66);
			const cut = Math.max(
				window.lastIndexOf('\n\n'),
				window.lastIndexOf('. '),
				window.lastIndexOf('\n'),
				window.lastIndexOf(' '),
			);
			if (cut >= floor) end = start + cut + 1;
		}
		const piece = clean.slice(start, end).trim();
		if (piece) chunks.push(piece);
		if (end >= clean.length) break;
		start = Math.max(end - CHUNK_OVERLAP, start + 1);
		// Start the next piece at a word, not in the middle of one.
		const space = clean.indexOf(' ', start);
		if (space !== -1 && space < end) start = space + 1;
	}
	return chunks;
}

/** A 2 × 53-bit non-cryptographic hash (cyrb53): enough to notice that a chunk changed. */
export function textHash(text: string): string {
	const one = (seed: number) => {
		let h1 = 0xdeadbeef ^ seed;
		let h2 = 0x41c6ce57 ^ seed;
		for (let i = 0; i < text.length; i++) {
			const ch = text.charCodeAt(i);
			h1 = Math.imul(h1 ^ ch, 2654435761);
			h2 = Math.imul(h2 ^ ch, 1597334677);
		}
		h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
		h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
		return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
	};
	return `${one(1)}${one(2)}${text.length.toString(16)}`;
}

/** Scales a vector to length 1 (a copy), so that a dot product is the cosine. */
export function normalize(vector: Float32Array): Float32Array {
	let sum = 0;
	for (const v of vector) sum += v * v;
	const length = Math.sqrt(sum);
	const out = new Float32Array(vector.length);
	if (length === 0) return out;
	for (let i = 0; i < vector.length; i++) out[i] = (vector[i] as number) / length;
	return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += (a[i] as number) * (b[i] as number);
	return sum;
}

const toBlob = (vector: Float32Array): Uint8Array =>
	new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));

const fromBlob = (blob: Uint8Array): Float32Array =>
	new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));

/** The best `k` scores seen so far, best first. */
export class TopK<T> {
	readonly items: { score: number; value: T }[] = [];
	private readonly k: number;
	constructor(k: number) {
		this.k = k;
	}
	/** Whether a score would enter. */
	wants(score: number): boolean {
		return this.items.length < this.k || score > (this.items.at(-1)?.score ?? -Infinity);
	}
	add(score: number, value: T): void {
		if (!this.wants(score)) return;
		let i = this.items.length;
		while (i > 0 && (this.items[i - 1] as { score: number }).score < score) i--;
		this.items.splice(i, 0, { score, value });
		if (this.items.length > this.k) this.items.pop();
	}
}

/* ───────────────────────── State ───────────────────────── */

const STATE_KEY = 'search_index';
const StateSchema = z.object({
	/** Extension id → the model key its index was last completely built with. */
	built: z.record(z.string(), z.string()).default({}),
	/** The last indexing failure that needs a person (no model, bad key…): code and time only. */
	lastError: z.object({ code: z.string(), at: z.number() }).nullable().default(null),
});
export type SearchIndexState = z.infer<typeof StateSchema>;

async function readState(db: DbExecutor): Promise<SearchIndexState> {
	const row = await db
		.withTables<CoreTables>()
		.selectFrom('core_settings')
		.select('value')
		.where('key', '=', STATE_KEY)
		.executeTakeFirst();
	const parsed = StateSchema.safeParse(row ? safeJson(row.value) : {});
	return parsed.success ? parsed.data : { built: {}, lastError: null };
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return {};
	}
}

async function writeState(db: DbExecutor, state: SearchIndexState, now: number) {
	const value = JSON.stringify(state);
	await db
		.withTables<CoreTables>()
		.insertInto('core_settings')
		.values({ key: STATE_KEY, value, updated_at: now })
		.onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: now }))
		.execute();
}

/* ───────────────────────── The service ───────────────────────── */

export interface SearchDeps {
	db: DbExecutor;
	clock: Clock;
	ids: IdGenerator;
	logger: Logger;
	llm: LlmPort;
	registry: () => Registry;
	access: () => Access;
	aiAreas: () => AiAreas;
	features: () => Features;
	/** Runs an action as an actor (the route delegates to the action). */
	invoke: (actionId: string, input: unknown, actor: Actor) => Promise<ActionResult<unknown>>;
	/** The extension's own context: what it loads for the index, it reads from its own tables. */
	contextFor: (extensionId: string) => ExtensionContext;
}

type KindEntry = { kind: string; extensionId: string; def: AiIndexKind };

const PagePayload = z.object({ cursor: z.string().nullable() });

export function createSearch(deps: SearchDeps) {
	const logger = deps.logger.child({ component: 'search' });
	const coreDb = (db: DbExecutor = deps.db) => db.withTables<CoreTables>();

	let kindsCache: Map<string, KindEntry> | undefined;
	/** The kinds extensions declared with `ai.index`, by kind. */
	const kinds = () => {
		if (!kindsCache) {
			kindsCache = new Map();
			for (const ext of deps.registry().extensions)
				for (const [kind, def] of Object.entries(ext.ai?.index?.kinds ?? {}))
					kindsCache.set(kind, { kind, extensionId: ext.id, def });
		}
		return kindsCache;
	};
	const hasIndex = () => kinds().size > 0;

	/* ── What may be indexed ── */

	type Gate = { ok: true; model: string } | { ok: false; reason: 'unset' | 'closed' };

	/**
	 * Whether an extension's data may be embedded now, and with which model: AI and search are on,
	 * an `embed` model is set, the area is open, and for a local-only area the provider is local.
	 */
	async function gate(extensionId: string, llm: LlmPort): Promise<Gate> {
		const policy = await llm.policy(INDEX_FEATURE, 'embed');
		if (!policy.enabled || !policy.model) return { ok: false, reason: 'unset' };
		if (!deps.features().isOn(extensionId)) return { ok: false, reason: 'closed' };
		const access = deps.aiAreas().access(extensionId);
		if (access === 'off' || (access === 'local' && !policy.local))
			return { ok: false, reason: 'closed' };
		return { ok: true, model: policy.model };
	}

	async function deleteEntity(kind: string, id: string, db: DbExecutor = deps.db) {
		await coreDb(db)
			.deleteFrom('core_embeddings')
			.where('source_kind', '=', kind)
			.where('source_id', '=', id)
			.execute();
	}

	async function deleteExtension(extensionId: string) {
		await coreDb().deleteFrom('core_embeddings').where('extension_id', '=', extensionId).execute();
	}

	/** Records a failure that needs a person; the usage log has the details. */
	async function noteFailure(code: string) {
		const state = await readState(deps.db);
		await writeState(
			deps.db,
			{ ...state, lastError: { code, at: deps.clock.now() } },
			deps.clock.now(),
		);
	}

	async function clearFailure() {
		const state = await readState(deps.db);
		if (state.lastError) await writeState(deps.db, { ...state, lastError: null }, deps.clock.now());
	}

	/**
	 * Brings one entity's chunks up to date: reads it, embeds the chunks whose text (or model)
	 * changed, drops the rest. Returns false when the model refused for a reason a retry cannot
	 * fix (the caller stops; the failure is recorded). Throws on retryable errors.
	 */
	async function embedEntity(ctx: JobContext, entry: KindEntry, id: string): Promise<boolean> {
		for (let round = 0; round < 3; round++) {
			const allowed = await gate(entry.extensionId, ctx.llm);
			if (!allowed.ok) {
				if (allowed.reason === 'closed') await deleteEntity(entry.kind, id);
				return true;
			}
			const doc = await entry.def.load(deps.contextFor(entry.extensionId), id);
			if (!doc) {
				await deleteEntity(entry.kind, id);
				return true;
			}
			// An entity of another area's audience (a vehicle's obligation) follows that area too.
			if (doc.capability && ownerOf(doc.capability) !== entry.extensionId) {
				const audience = await gate(ownerOf(doc.capability), ctx.llm);
				if (!audience.ok) {
					await deleteEntity(entry.kind, id);
					return true;
				}
			}
			const capability = doc.capability ?? entry.def.capability;
			const pieces = chunkText(doc.text);
			const texts = (pieces.length > 0 ? pieces : ['']).map((p) =>
				p ? `${doc.title}\n${p}` : doc.title,
			);
			const hashes = texts.map(textHash);
			const existing = await coreDb()
				.selectFrom('core_embeddings')
				.select(['id', 'chunk_index', 'text_hash', 'model'])
				.where('source_kind', '=', entry.kind)
				.where('source_id', '=', id)
				.execute();
			const byIndex = new Map(existing.map((r) => [r.chunk_index, r]));
			const stale: number[] = [];
			texts.forEach((_, i) => {
				const row = byIndex.get(i);
				if (!row || row.text_hash !== hashes[i] || row.model !== allowed.model) stale.push(i);
			});

			const fresh = new Map<number, { vector: Float32Array; model: string }>();
			try {
				for (let from = 0; from < stale.length; from += EMBED_BATCH) {
					const batch = stale.slice(from, from + EMBED_BATCH);
					const result = await ctx.llm.embed({
						feature: INDEX_FEATURE,
						area: entry.extensionId,
						texts: batch.map((i) => texts[i] as string),
						timeoutMs: INDEX_TIMEOUT_MS,
					});
					batch.forEach((chunk, n) => {
						fresh.set(chunk, {
							vector: normalize(result.vectors[n] as Float32Array),
							model: result.model,
						});
					});
				}
			} catch (error) {
				if (isLlmError(error) && !error.retryable) {
					// A person must act (no model, bad key, limit): record it, do not retry in a loop.
					logger.warn({ code: error.code, kind: entry.kind }, 'indexing stopped');
					await noteFailure(error.code);
					return false;
				}
				throw error;
			}

			const now = deps.clock.now();
			await deps.db.transaction().execute(async (trx) => {
				const t = coreDb(trx);
				await t
					.deleteFrom('core_embeddings')
					.where('source_kind', '=', entry.kind)
					.where('source_id', '=', id)
					.where('chunk_index', '>=', texts.length)
					.execute();
				const owner = doc.ownerMemberId ?? null;
				// Entries that stay: only what is stored next to the vector may have moved.
				await t
					.updateTable('core_embeddings')
					.set({
						title: doc.title,
						href: doc.href,
						owner_member_id: owner,
						capability,
					})
					.where('source_kind', '=', entry.kind)
					.where('source_id', '=', id)
					.execute();
				for (const [i, item] of fresh) {
					await t
						.deleteFrom('core_embeddings')
						.where('source_kind', '=', entry.kind)
						.where('source_id', '=', id)
						.where('chunk_index', '=', i)
						.execute();
					await t
						.insertInto('core_embeddings')
						.values({
							id: deps.ids.next('embedding'),
							extension_id: entry.extensionId,
							source_kind: entry.kind,
							source_id: id,
							capability,
							owner_member_id: owner,
							title: doc.title,
							href: doc.href,
							snippet: (pieces[i] ?? doc.title).slice(0, SNIPPET_CHARS),
							model: item.model,
							dimensions: item.vector.length,
							text_hash: hashes[i] as string,
							chunk_index: i,
							vector: toBlob(item.vector),
							updated_at: now,
						})
						.execute();
				}
			});
			await clearFailure();

			// A change that arrived while the model worked was deduplicated into this job: look again.
			const again = await entry.def.load(deps.contextFor(entry.extensionId), id);
			if (!again || again.title + again.text === doc.title + doc.text) return true;
		}
		return true;
	}

	/* ── Jobs ── */

	const embedJob = defineJob({
		name: EMBED_JOB,
		payload: z.object({ kind: z.string(), id: z.string() }),
		timeoutMs: 180_000,
		async handle(ctx, { kind, id }) {
			const entry = kinds().get(kind);
			if (!entry) return;
			await embedEntity(ctx, entry, id);
		},
	});

	const syncJob = defineJob({
		name: SYNC_JOB,
		payload: z.object({}),
		async handle(ctx) {
			const policy = await ctx.llm.policy(INDEX_FEATURE, 'embed');
			const state = await readState(deps.db);
			const extensionIds = new Set([...kinds().values()].map((k) => k.extensionId));
			let changed = false;
			if (!policy.enabled || !policy.model) {
				// Changes made meanwhile are not indexed: forget what was built, so whatever model
				// comes next (even the same one) reads everything again (unchanged text is skipped).
				if (Object.keys(state.built).length > 0)
					await writeState(deps.db, { ...state, built: {} }, deps.clock.now());
				return;
			}
			for (const extensionId of extensionIds) {
				const access = deps.aiAreas().access(extensionId);
				const closed =
					!deps.features().isOn(extensionId) ||
					access === 'off' ||
					(access === 'local' && !policy.local);
				if (closed && policy.model) {
					// Turned off (or local-only with a model that is not local): nothing may stay.
					await deleteExtension(extensionId);
					if (state.built[extensionId]) {
						delete state.built[extensionId];
						changed = true;
					}
					continue;
				}
				if (closed || !policy.enabled || !policy.model) continue;
				if (state.built[extensionId] === policy.model) continue;
				await ctx.enqueue(
					REBUILD_JOB,
					{ extensionId, model: policy.model, cursor: null },
					{ dedupeKey: `${REBUILD_JOB}:${extensionId}:${policy.model}:start` },
				);
			}
			if (changed) await writeState(deps.db, state, deps.clock.now());
		},
	});

	const rebuildJob = defineJob({
		name: REBUILD_JOB,
		payload: z.object({
			extensionId: z.string(),
			model: z.string(),
			cursor: PagePayload.shape.cursor,
		}),
		lane: 'long',
		timeoutMs: 15 * 60_000,
		async handle(ctx, { extensionId, model, cursor }) {
			const index = deps.registry().extensions.find((e) => e.id === extensionId)?.ai?.index;
			if (!index) return;
			// The model changed again, or the area closed, since this was queued: a newer sync decides.
			const allowed = await gate(extensionId, ctx.llm);
			if (!allowed.ok || allowed.model !== model) return;

			const page = await index.list(deps.contextFor(extensionId), cursor);
			for (const item of page.items) {
				const entry = kinds().get(item.kind);
				if (!entry) continue;
				if (!(await embedEntity(ctx, entry, item.id))) return;
			}
			if (page.next !== null) {
				await ctx.enqueue(
					REBUILD_JOB,
					{ extensionId, model, cursor: page.next },
					{
						dedupeKey: `${REBUILD_JOB}:${extensionId}:${model}:${page.next}`,
						runAt: deps.clock.now() + REBUILD_PAGE_PAUSE_MS,
					},
				);
				return;
			}
			// Done: what is left of an older model (entities deleted meanwhile) goes.
			await coreDb()
				.deleteFrom('core_embeddings')
				.where('extension_id', '=', extensionId)
				.where('model', '!=', model)
				.execute();
			const state = await readState(deps.db);
			state.built[extensionId] = model;
			await writeState(deps.db, state, deps.clock.now());
		},
	});

	/* ── Asking for (re)indexing ── */

	const checkKind = (kind: string) => {
		if (!kinds().has(kind)) throw new Error(`Unknown search kind "${kind}"`);
	};
	const dedupeKey = (kind: string, id: string) => `${EMBED_JOB}:${kind}:${id}`;

	/** The indexer of a unit of work: jobs join the transaction. */
	const indexerFor = (
		enqueue: (job: string, payload: unknown, options?: { dedupeKey?: string }) => Promise<string>,
		removeFrom: DbExecutor | null,
	): SearchIndexer => ({
		async reindex(kind, id) {
			checkKind(kind);
			await enqueue(EMBED_JOB, { kind, id }, { dedupeKey: dedupeKey(kind, id) });
		},
		async remove(kind, id) {
			checkKind(kind);
			// Gone with the entity, in the same transaction; nothing to wait for.
			await deleteEntity(kind, id, removeFrom ?? deps.db);
		},
	});

	/* ── Searching ── */

	/** Whether the asker holds a capability: a person, or the AI for the person it works for. */
	function holds(actor: Actor, capability: string): boolean {
		const access = deps.access();
		if (actor.kind === 'ai')
			return actor.onBehalfOf !== undefined && access.memberCan(actor, capability);
		if (actor.kind === 'member' || actor.kind === 'system') return access.can(actor, capability);
		return false;
	}

	const memberOf = memberBehind;

	/** Whether an area's data may be used for this asker (the AI sandbox). */
	function areaOpen(actor: Actor, extensionId: string): boolean {
		if (!deps.features().isOn(extensionId)) return false;
		const area = deps.aiAreas().access(extensionId);
		if (area === 'off') return false;
		// Local-only data reaches a model only if that model is on the family's network.
		return !(area === 'local' && actor.kind === 'ai' && actor.local !== true);
	}

	/**
	 * What an asker may search: the kinds whose area is open and whose capability they hold, and
	 * the capabilities entities may name as their audience (held, in an area that is open).
	 */
	function allowed(actor: Actor): { kinds: string[]; viewAll: string[]; capabilities: string[] } {
		const kindIds: string[] = [];
		const viewAll: string[] = [];
		for (const entry of kinds().values()) {
			if (!areaOpen(actor, entry.extensionId)) continue;
			if (!holds(actor, entry.def.capability)) continue;
			kindIds.push(entry.kind);
			if (entry.def.viewAll && holds(actor, entry.def.viewAll)) viewAll.push(entry.kind);
		}
		const capabilities = deps
			.registry()
			.capabilities.filter((c) => areaOpen(actor, ownerOf(c.id)) && holds(actor, c.id))
			.map((c) => c.id);
		return { kinds: kindIds, viewAll, capabilities };
	}

	const ResultSchema = z.object({
		/** The entity's id (the AI sees a handle instead). */
		id: z.string(),
		kind: z.string(),
		extension: z.string(),
		title: z.string(),
		snippet: z.string(),
		/** A path inside the app; left out for the AI. */
		href: z.string().nullable(),
	});
	type Result = z.infer<typeof ResultSchema>;

	const PAGE = 2000;

	/** What the asker may read of the stored chunks, in SQL: nothing else is ever loaded or scored. */
	function readableRows(db: DbExecutor, actor: Actor, model: string, dimensions: number) {
		const { kinds: all, viewAll, capabilities } = allowed(actor);
		if (all.length === 0 || capabilities.length === 0) return null;
		const me = memberOf(actor);
		return coreDb(db)
			.selectFrom('core_embeddings')
			.where('model', '=', model)
			.where('dimensions', '=', dimensions)
			.where('source_kind', 'in', all)
			.where('capability', 'in', capabilities)
			.where((eb) => {
				const open = [eb('owner_member_id', 'is', null)];
				if (me) open.push(eb('owner_member_id', '=', me));
				if (viewAll.length > 0) open.push(eb('source_kind', 'in', viewAll));
				return eb.or(open);
			});
	}

	/** The chunks that score best against a question, best first: their row ids. */
	type Ranked = { id: string; kind: string; sourceId: string }[];

	/**
	 * Scores the stored vectors the asker may read against a question. It runs before the action's
	 * transaction, a page at a time with a pause between pages, so a large index never holds the
	 * one connection that every other request and write waits for.
	 */
	async function scan(
		actor: Actor,
		query: Float32Array,
		model: string,
		limit: number,
	): Promise<Ranked> {
		const rows = readableRows(deps.db, actor, model, query.length);
		if (!rows) return [];
		const best = new TopK<{ id: string; kind: string; sourceId: string }>(limit * 5);
		let last = '';
		for (;;) {
			const page = await rows
				.select(['id', 'source_kind', 'source_id', 'vector'])
				.where('id', '>', last)
				.orderBy('id')
				.limit(PAGE)
				.execute();
			for (const row of page) {
				const score = dot(query, fromBlob(row.vector));
				// Nothing in common with the question is no result, whatever else is stored.
				if (score <= 0 || !best.wants(score)) continue;
				best.add(score, { id: row.id, kind: row.source_kind, sourceId: row.source_id });
			}
			if (page.length < PAGE) break;
			last = (page.at(-1) as { id: string }).id;
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		return best.items.map(({ value }) => value);
	}

	/**
	 * The results for the chunks that ranked best: read again inside the transaction, with the
	 * asker's rights applied again, so a chunk removed or closed to them meanwhile is left out.
	 */
	async function pick(
		db: DbExecutor,
		actor: Actor,
		ranked: Ranked,
		model: string,
		dimensions: number,
		limit: number,
	): Promise<Result[]> {
		// One result per entity (its best chunk).
		const seen = new Set<string>();
		const winners: string[] = [];
		for (const chunk of ranked) {
			const key = `${chunk.kind}:${chunk.sourceId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			winners.push(chunk.id);
		}
		const rows = winners.length > 0 ? readableRows(db, actor, model, dimensions) : null;
		if (!rows) return [];
		const found = new Map(
			(
				await rows
					.select(['id', 'extension_id', 'source_kind', 'source_id', 'title', 'snippet', 'href'])
					.where('id', 'in', winners)
					.execute()
			).map((row) => [row.id, row]),
		);
		const out: Result[] = [];
		for (const id of winners) {
			const row = found.get(id);
			if (!row) continue;
			out.push({
				id: row.source_id,
				kind: row.source_kind,
				extension: row.extension_id,
				title: row.title,
				snippet: row.snippet,
				href: actor.kind === 'ai' ? null : row.href,
			});
			if (out.length >= limit) break;
		}
		return out;
	}

	const SearchInput = z.object({
		query: z.string().trim().min(2).max(300).describe('What to look for, in the family language'),
		limit: z
			.number()
			.int()
			.min(1)
			.max(MAX_RESULTS)
			.default(5)
			.describe('At most this many results'),
	});

	const searchAction = defineAction({
		id: SEARCH_ACTION,
		title: 'Search the family’s records by meaning',
		input: SearchInput,
		output: z.object({ results: z.array(ResultSchema) }),
		readOnly: true,
		ai: {
			description:
				'Finds things by meaning across what the family keeps: shared inbox items, recipes, home things and services, calendar events, records and papers. Use it when the person describes something without its exact name ("the paper about the boiler warranty"). Each result names a kind, a title and a short snippet; open the full record with the tool of the area it belongs to.',
			guidance:
				'query is a short phrase or question in the language of the records, not a list of keywords. Results are only what this person may see.',
		},
		async prepare({ query, limit }, actor) {
			// The AI works for a person here; with nobody asking there is nobody whose rights apply.
			if (actor.kind === 'ai' && actor.onBehalfOf === undefined)
				throw new FamosError('forbidden', 'Search needs a person to search for');
			const policy = await deps.llm.policy(QUERY_FEATURE, 'embed');
			if (!policy.enabled || !policy.model)
				throw new FamosError('conflict', 'not_configured', { reason: 'not_configured' });
			let embedded: LlmEmbedResult;
			try {
				embedded = await deps.llm.embed({
					feature: QUERY_FEATURE,
					area: 'core',
					texts: [query],
					timeoutMs: QUERY_TIMEOUT_MS,
					memberId: memberOf(actor),
				});
			} catch (error) {
				if (isLlmError(error)) {
					if (
						error.code === 'not_configured' ||
						error.code === 'model_not_found' ||
						error.code === 'disabled'
					)
						throw new FamosError('conflict', 'not_configured', { reason: 'not_configured' });
					throw new FamosError('unavailable', 'Search could not reach the embedding model', {
						reason: error.code,
					});
				}
				throw error;
			}
			const vector = normalize(embedded.vectors[0] as Float32Array);
			return {
				model: embedded.model,
				dimensions: vector.length,
				ranked: await scan(actor, vector, embedded.model, limit),
			};
		},
		async run(uow, { query: _query, limit }, prepared) {
			if (!prepared)
				throw new FamosError('conflict', 'not_configured', { reason: 'not_configured' });
			const { ranked, model, dimensions } = prepared;
			return { results: await pick(uow.db, uow.actor, ranked, model, dimensions, limit) };
		},
	});

	const searchRoute = defineRoute({
		method: 'get',
		path: '/search',
		operationId: 'core.searchFamily',
		summary:
			'Search the family’s records by meaning (409 not_configured without an embedding model)',
		requires: 'signedIn',
		query: z.object({
			q: z.string().trim().min(2).max(300),
			limit: z.coerce.number().int().min(1).max(MAX_RESULTS).optional(),
		}),
		response: z.object({ results: z.array(ResultSchema) }),
		async handle(_ctx, { query, actor }) {
			const done = await deps.invoke(
				SEARCH_ACTION,
				{ query: query.q, ...(query.limit !== undefined && { limit: query.limit }) },
				actor,
			);
			if (done.status !== 'applied') throw new FamosError('conflict', 'The search did not run');
			return done.output as { results: Result[] };
		},
	});

	/** Which areas search covers (Settings → AI), and the last failure that needs a person. */
	async function coverage(): Promise<{ id: string; covered: boolean }[]> {
		const policy = await deps.llm.policy(INDEX_FEATURE, 'embed');
		const ids = [...new Set([...kinds().values()].map((k) => k.extensionId))];
		return ids.map((id) => {
			const access = deps.aiAreas().access(id);
			return {
				id,
				covered:
					Boolean(policy.enabled && policy.model) &&
					deps.features().isOn(id) &&
					(access === 'any' || (access === 'local' && policy.local)),
			};
		});
	}

	const statusRoute = defineRoute({
		method: 'get',
		path: '/search/status',
		operationId: 'core.searchStatus',
		summary: 'Whether search is set up, and which areas it covers',
		requires: 'signedIn',
		response: z.object({
			configured: z.boolean(),
			error: z.string().nullable(),
			areas: z.array(z.object({ id: z.string(), covered: z.boolean() })),
		}),
		async handle() {
			const policy = await deps.llm.policy(QUERY_FEATURE, 'embed');
			return {
				configured: Boolean(policy.enabled && policy.model),
				error: (await readState(deps.db)).lastError?.code ?? null,
				areas: await coverage(),
			};
		},
	});

	return {
		jobs: [embedJob, syncJob, rebuildJob],
		actions: [searchAction],
		routes: [searchRoute, statusRoute],
		hasIndex,
		indexerFor,
		coverage,
		state: () => readState(deps.db),
	};
}

export type Search = ReturnType<typeof createSearch>;
