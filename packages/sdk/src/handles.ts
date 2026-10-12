/**
 * Handles: short names (`member:1`, `vehicle:2`) that stand for ids in what a model reads and
 * writes. Models copy long ids unreliably (one wrong character still looks valid), so ids never
 * reach a prompt; a handle is mapped back before anything is drafted. One table per prompt or
 * chat turn, shared by the Inbox and the assistant.
 */
export interface HandleTable {
	/** The handle of `id` (`<kind>:<n>`), assigned on first use. */
	add(kind: string, id: string): string;
	/** The handle of an id, if it has one. */
	handleOf(id: string): string | undefined;
	/** Handle → id, for mapping a model's input back. */
	readonly toId: ReadonlyMap<string, string>;
	/** Every id with a handle. */
	ids(): ReadonlySet<string>;
}

/**
 * `known` holds handles shown in earlier turns of a conversation (handle → id): they keep their
 * meaning, and new handles continue after the highest number of each kind.
 */
export function createHandleTable(known: Readonly<Record<string, string>> = {}): HandleTable {
	const toId = new Map<string, string>();
	const byId = new Map<string, string>();
	const counters = new Map<string, number>();
	for (const [handle, id] of Object.entries(known)) {
		const [kind, n] = handle.split(':');
		if (!kind || !/^\d+$/.test(n ?? '')) continue;
		toId.set(handle, id);
		byId.set(id, handle);
		counters.set(kind, Math.max(counters.get(kind) ?? 0, Number(n)));
	}
	return {
		add(kind, id) {
			const known = byId.get(id);
			if (known) return known;
			const n = (counters.get(kind) ?? 0) + 1;
			counters.set(kind, n);
			const handle = `${kind}:${n}`;
			toId.set(handle, id);
			byId.set(id, handle);
			return handle;
		},
		handleOf: (id) => byId.get(id),
		toId,
		ids: () => new Set(byId.keys()),
	};
}

/** A typed id: `<prefix>_<uuid>` (see `idSchema`). */
const TYPED_ID =
	/^([a-z][a-z0-9]*(?:_[a-z0-9]+)*)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The prefix of a typed id, or null when the text is not one. */
export const typedIdKind = (text: string): string | null => TYPED_ID.exec(text)?.[1] ?? null;

/**
 * Replaces every typed id in a value (an action's output) by its handle, adding handles as
 * needed; the kind is the id's prefix. Anything else is kept. The result has no id in it.
 */
export function withHandles(value: unknown, table: HandleTable): unknown {
	if (typeof value === 'string') {
		const kind = typedIdKind(value);
		return kind ? table.add(kind, value) : value;
	}
	if (Array.isArray(value)) return value.map((v) => withHandles(v, table));
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withHandles(v, table)]));
	}
	return value;
}

/**
 * Whether a model's input holds a typed id the model was never shown (an invented one). Run it
 * after `repairInput` has mapped the handles back: every id left must be one in the table.
 */
export function namesUnknownId(value: unknown, table: HandleTable): boolean {
	return unknownIdFields(value, table).length > 0;
}

/**
 * The fields of a model's input that hold an id it was never shown, as paths (`listId`,
 * `items[0].id`), so a refusal can say which one to look up again.
 */
export function unknownIdFields(value: unknown, table: HandleTable, path = ''): string[] {
	if (typeof value === 'string')
		return typedIdKind(value) !== null && !table.ids().has(value) ? [path || '(input)'] : [];
	if (Array.isArray(value))
		return value.flatMap((v, i) => unknownIdFields(v, table, `${path}[${i}]`));
	if (value && typeof value === 'object')
		return Object.entries(value).flatMap(([k, v]) =>
			unknownIdFields(v, table, path ? `${path}.${k}` : k),
		);
	return [];
}

/**
 * Repairs two habits of models seen with real providers before an action validates:
 * - `null` for fields they leave out: for proposals (which create things) absent and `null`
 *   mean the same, so nulls are dropped;
 * - nested values written as JSON text (`"memberIds": "[]"`): strings that parse to an array or
 *   object are replaced by the parsed value.
 * Handles in the table are replaced by their ids on the way.
 */
export function repairInput(
	value: unknown,
	handles: ReadonlyMap<string, string> = new Map(),
): unknown {
	if (typeof value === 'string') {
		const text = value.trim();
		const id = handles.get(text);
		if (id) return id;
		if (
			(text.startsWith('[') && text.endsWith(']')) ||
			(text.startsWith('{') && text.endsWith('}'))
		) {
			try {
				const parsed: unknown = JSON.parse(text);
				if (parsed && typeof parsed === 'object') return repairInput(parsed, handles);
			} catch {
				// Not JSON after all: keep the text.
			}
		}
		return value;
	}
	if (Array.isArray(value)) return value.map((v) => repairInput(v, handles));
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, v]) => v !== null)
				.map(([k, v]) => [k, repairInput(v, handles)]),
		);
	}
	return value;
}
