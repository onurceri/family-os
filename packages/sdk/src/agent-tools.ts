import { AiContextSchema } from './actions.ts';
import type { Actor } from './actor.ts';
import type { ActionInvoker, ActionResult, DraftMeta } from './context.ts';
import { isFamosError } from './errors.ts';
import {
	type HandleTable,
	repairInput,
	typedIdKind,
	unknownIdFields,
	withHandles,
} from './handles.ts';
import { type RefusalReason, refusalOf, resolvePeople } from './understanding.ts';

/**
 * What every agent (the in-app assistant, MCP clients) shares when a model
 * calls an action as a tool: handles instead of ids, results wrapped as data, failures that tell
 * the model what to fix without echoing its input, and drafts for every change.
 */

/** A tool result longer than this is cut, so one answer cannot fill the context. */
export const MAX_RESULT_BYTES = 16_384;

/** The UTF-8 size of a text (this package has no TextEncoder). */
function utf8Length(text: string): number {
	let bytes = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) as number;
		bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
	}
	return bytes;
}

/**
 * Tool results are data, never instructions: they are wrapped in a block the system
 * prompt names, and anything that could close the block is neutralised.
 */
export function asData(name: string, text: string): string {
	const body = text.replaceAll('</tool_result', '<\\/tool_result');
	let bytes = 0;
	let end = 0;
	// The last resort, for text that is not a list (lists are cut by whole items in `fitResult`):
	// cut on a character boundary at MAX_RESULT_BYTES of UTF-8 and say so.
	for (const ch of body) {
		const code = ch.codePointAt(0) as number;
		bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
		if (bytes > MAX_RESULT_BYTES) {
			return `<tool_result name="${name}">\n${body.slice(0, end)}\n…(shortened: the rest of this result was left out)\n</tool_result>`;
		}
		end += ch.length;
	}
	return `<tool_result name="${name}">\n${body}\n</tool_result>`;
}

/** `path: message` pairs from a failed validation, without values (they come from the model). */
function issues(details: unknown): string {
	const tree = details as { errors?: string[]; properties?: Record<string, unknown> } | null;
	const out: string[] = [...(tree?.errors ?? [])];
	for (const [key, value] of Object.entries(tree?.properties ?? {}))
		out.push(`${key}: ${((value as { errors?: string[] }).errors ?? []).join('; ') || 'invalid'}`);
	return out.slice(0, 8).join('; ');
}

/**
 * What each refusal reason tells a model calling a tool, so every agent hears the same words for
 * the same reason, whichever action refused.
 */
const REFUSAL_WORDS: Record<RefusalReason, string> = {
	already: 'it is already so, nothing needs to change',
	unknown: 'what it names is not there',
	ambiguous: 'several things fit; ask the person which one they mean',
	incomplete: 'the input is incomplete or not valid',
	not_allowed: 'not allowed for this person',
};

/** A refusal as the model reads it: the reason, its words, and what to do about it. */
export function refusalText(reason: RefusalReason, detail?: string): string {
	return `Error (${reason}): ${REFUSAL_WORDS[reason]}${detail ? `. ${detail}` : ''}`;
}

/** What a failed call tells the model: enough to fix the input or to say it cannot be done. */
export function toolFailure(error: unknown): string {
	if (!isFamosError(error)) return 'Error: the tool failed';
	const refusals = ['bad_request', 'forbidden', 'not_found', 'conflict'];
	if (!refusals.includes(error.code)) return `Error: ${error.message}`;
	const reason = refusalOf(error);
	// Without details the action itself refused the input and says why (an unknown list name,
	// with the real names; "That is X, not Y"). Validation details name the fields to fix, never
	// their values. A missing record says nothing more: its message may hold the id.
	const detail =
		error.code === 'not_found' || error.code === 'forbidden'
			? undefined
			: error.code === 'bad_request' && error.details
				? `Fix: ${issues(error.details)}`
				: error.message;
	return refusalText(reason, detail);
}

/** The prefix a typed-id pattern in a JSON Schema names (`^shop_list_[0-9a-f]{8}-…$`). */
const ID_PATTERN = /^\^([a-z][a-z0-9]*(?:_[a-z0-9]+)*)_\[0-9a-f\]\{8\}-/;

type JsonSchema = Record<string, unknown>;

/** The kind of record a schema node refers to, when it is a typed id. */
function referenceKind(node: unknown): string | null {
	const schema = node as JsonSchema | null;
	if (!schema || typeof schema !== 'object' || typeof schema.pattern !== 'string') return null;
	return ID_PATTERN.exec(schema.pattern)?.[1] ?? null;
}

/** The schemas a value under `node` may follow: the node, or the branches of a union. */
function branches(node: unknown): JsonSchema[] {
	const schema = node as JsonSchema | null;
	if (!schema || typeof schema !== 'object') return [];
	const union = [schema.anyOf, schema.oneOf, schema.allOf].find(Array.isArray) as
		| JsonSchema[]
		| undefined;
	return union ? [schema, ...union.flatMap(branches)] : [schema];
}

const referenceWords = (kind: string) =>
	kind === 'member'
		? `A person: the "member:…" reference the family list or a tool result gives, or the person's name.`
		: `A "${kind}:…" reference exactly as a tool result gave it; look it up with a read tool first. Never make one up.`;

/**
 * An action's input schema as an agent reads it. A typed id is described as a reference
 * (`shop_list:…`) with no id pattern: a model that reads the pattern writes a made-up id that fits
 * it instead of the reference it was given. Ids never reach the model, not even their shape.
 */
export function agentInputSchema(schema: JsonSchema): JsonSchema {
	const walk = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(walk);
		if (!node || typeof node !== 'object') return node;
		const kind = referenceKind(node);
		const out: JsonSchema = {};
		for (const [key, value] of Object.entries(node as JsonSchema)) {
			if (kind && key === 'pattern') continue;
			out[key] =
				key === 'properties' && value && typeof value === 'object'
					? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]))
					: walk(value);
		}
		if (kind)
			out.description = [out.description, referenceWords(kind)]
				.filter((part) => typeof part === 'string' && part !== '')
				.join('. ');
		return out;
	};
	return walk(schema) as JsonSchema;
}

/**
 * The top-level fields of an input schema that hold references of `kind` (one, or a list), such
 * as the people of an event (`memberIds`) or of a task (`assigneeId`).
 */
export function referenceFields(schema: JsonSchema, kind: string): string[] {
	const properties = (schema.properties ?? {}) as JsonSchema;
	return Object.entries(properties)
		.filter(([, node]) =>
			branches(node).some(
				(o) =>
					referenceKind(o) === kind ||
					branches(o.items).some((item) => referenceKind(item) === kind),
			),
		)
		.map(([key]) => key);
}

/** What the host knows to turn a model's reference into an id. */
export interface ReferenceBook {
	table: HandleTable;
	/** The family, so a person's name in a member field is that member. */
	people?: readonly { id: string; displayName: string }[];
	/** The family language, for matching names. */
	locale?: string;
}

/**
 * The id a model's reference to a `kind` stands for: a reference it was shown, also as models
 * miswrite it (`member_3`, `Member 3`, `3` for `member:3`), or for a person their name, when exactly
 * one member has it. Undefined when it names nothing the host knows.
 */
export function referenceId(kind: string, text: string, book: ReferenceBook): string | undefined {
	const said = text.trim();
	if (book.table.ids().has(said)) return said;
	const shown = book.table.toId.get(said);
	if (shown) return shown;
	// The number alone ("2" for member:2).
	const numbered = /^\d+$/.test(said) ? book.table.toId.get(`${kind}:${said}`) : undefined;
	if (numbered) return numbered;
	if (said.toLowerCase().startsWith(kind)) {
		const rest = said
			.slice(kind.length)
			.replace(/^[\s_:#-]+/, '')
			.toLowerCase();
		const written = /^[0-9a-f]+$/.test(rest) ? book.table.toId.get(`${kind}:${rest}`) : undefined;
		if (written) return written;
	}
	if (kind === 'member' && book.people && said !== '') {
		const { ids } = resolvePeople(
			{ people: [said] },
			{ members: book.people, sharer: null, text: null, locale: book.locale ?? 'en' },
		);
		if (ids.length === 1) return ids[0];
	}
	return undefined;
}

/**
 * Turns the references in a model's input into ids, guided by the action's input schema: each
 * typed-id field is looked up (`referenceId`). An empty text in such a field counts as left out
 * (models fill every field they see). Returns the input and the paths of references that name
 * nothing known, which are invented.
 */
export function resolveReferences(
	input: unknown,
	schema: JsonSchema,
	book: ReferenceBook,
): { input: unknown; unknown: string[] } {
	const unknown: string[] = [];
	const walk = (value: unknown, node: unknown, path: string): unknown => {
		const options = branches(node);
		if (typeof value === 'string') {
			const kind = options.map(referenceKind).find((k) => k !== null);
			if (!kind) return value;
			const id = referenceId(kind, value, book);
			if (id) return id;
			unknown.push(path || '(input)');
			return value;
		}
		if (Array.isArray(value)) {
			const items = options.map((o) => o.items).find((i) => i && typeof i === 'object');
			const kept = items
				? value.filter((v) => !(v === '' && referenceKind(items) !== null))
				: value;
			return kept.map((v, i) => walk(v, items, `${path}[${i}]`));
		}
		if (value && typeof value === 'object') {
			const properties = Object.assign(
				{},
				...options.map((o) => (o.properties as JsonSchema | undefined) ?? {}),
			) as JsonSchema;
			const out: Record<string, unknown> = {};
			for (const [key, v] of Object.entries(value)) {
				const sub = properties[key];
				if (v === '' && branches(sub).some((o) => referenceKind(o) !== null)) continue;
				out[key] = walk(v, sub, path ? `${path}.${key}` : key);
			}
			return out;
		}
		return value;
	};
	return { input: walk(input, schema, ''), unknown };
}

/**
 * Leaves out what tells the model nothing: null, empty text, empty objects, and empty lists
 * inside items. Every field costs tokens on each step of a turn, because earlier results are sent
 * again. `false` stays (an absent flag reads as "unknown", not "no"), and so does an empty list at
 * the top, which is the answer "there are none".
 */
export function compact(value: unknown, depth = 0): unknown {
	if (Array.isArray(value)) return value.map((v) => compact(v, depth + 1));
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(value)) {
			const kept = compact(v, depth + 1);
			if (kept === null || kept === undefined || kept === '') continue;
			if (Array.isArray(kept) && kept.length === 0 && depth > 0) continue;
			if (typeof kept === 'object' && !Array.isArray(kept) && Object.keys(kept).length === 0)
				continue;
			out[key] = kept;
		}
		return out;
	}
	return value;
}

const CUT_HINT = 'Narrow the query (a shorter date range or a text filter) to see the rest.';

/**
 * A result as JSON that fits `MAX_RESULT_BYTES`. When it is too long, whole trailing items of
 * the longest list are dropped (never half an item) and a `cut` field says how many are shown
 * of how many, so the model knows to narrow the query instead of trusting a partial list.
 * A result with no list is returned as is; `asData` then cuts the text and says so.
 */
export function fitResult(value: unknown): string {
	const whole = JSON.stringify(value);
	// Room for the wrapper and the `cut` field.
	const budget = MAX_RESULT_BYTES - 400;
	if (utf8Length(whole) <= budget) return whole;
	let holder: Record<string, unknown>;
	let key = '';
	if (Array.isArray(value)) {
		holder = {};
		key = 'items';
	} else if (value && typeof value === 'object') {
		holder = { ...(value as Record<string, unknown>) };
		let longest = -1;
		for (const [k, v] of Object.entries(holder)) {
			const size = Array.isArray(v) ? utf8Length(JSON.stringify(v)) : -1;
			if (size > longest) {
				longest = size;
				key = k;
			}
		}
		if (!key) return whole;
	} else return whole;
	const list = (Array.isArray(value) ? value : holder[key]) as unknown[];
	const render = (shown: number) =>
		JSON.stringify({
			...holder,
			[key]: list.slice(0, shown),
			cut: { shown, total: list.length, hint: CUT_HINT },
		});
	// The most items that fit; the size grows with the count, so a binary search finds it.
	let low = 0;
	let high = list.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (utf8Length(render(mid)) <= budget) low = mid;
		else high = mid - 1;
	}
	return render(low);
}

/**
 * A day (`2026-10-20`) or a local time on it (`2026-10-20T18:00`). An instant with an offset is
 * left out: its day depends on the time zone it is read in.
 */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+)?$/;

const WEEKDAY = new Intl.DateTimeFormat('en', { weekday: 'long', timeZone: 'UTC' });

/** The English weekday of a date written at the start of a value, or null. */
export function weekdayOf(value: string): string | null {
	const m = ISO_DATE.exec(value);
	if (!m) return null;
	const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	// A date that does not exist (2026-02-31) rolls over: it gets no weekday.
	if (at.getUTCDate() !== Number(m[3])) return null;
	return WEEKDAY.format(at);
}

/**
 * Every date in a result with its weekday beside it (`dueDate` → `dueDateWeekday`): models name
 * the weekday of a date themselves and get it wrong ("Monday 20 October" for a Tuesday), so code
 * says it. An object whose action names its weekdays already (a `weekday` or `…Weekday` field)
 * is left as it is. The date stays as it was, so a model can send it back in a tool input.
 */
export function withWeekdays(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withWeekdays);
	if (!value || typeof value !== 'object') return value;
	const record = value as Record<string, unknown>;
	const named = Object.keys(record).some((key) => key === 'weekday' || key.endsWith('Weekday'));
	const out: Record<string, unknown> = {};
	for (const [key, v] of Object.entries(record)) {
		out[key] = withWeekdays(v);
		const weekday = !named && typeof v === 'string' ? weekdayOf(v) : null;
		if (weekday) out[`${key}Weekday`] = weekday;
	}
	return out;
}

/**
 * An action's output as the model reads it: ids become handles, record lists are compact, and
 * dates carry their weekdays.
 */
export function readableOutput(output: unknown, table: HandleTable): unknown {
	const context = AiContextSchema.safeParse(output);
	if (context.success && context.data.plain) {
		return { [context.data.label]: context.data.items.map((item) => item.label) };
	}
	if (context.success) {
		return {
			[context.data.label]: context.data.items.map((item) => ({
				ref: table.add(context.data.kind, item.id),
				name: item.label,
				...(item.details && { details: item.details }),
			})),
		};
	}
	return withWeekdays(compact(withHandles(output, table)));
}

/** The id and the person's words of a change aimed at one record, or null. */
function targetOf(input: unknown): { id: string; words: string; said: string } | null {
	const { id, label } = (input ?? {}) as { id?: unknown; label?: unknown };
	if (typeof id !== 'string' || typeof label !== 'string') return null;
	const said = label.trim().replace(/\s+/g, ' ');
	return said === '' ? null : { id, said, words: said.toLocaleLowerCase() };
}

const MAX_LABEL = 80;

/**
 * Notes what each record in a result is called: an object with a typed `id` and a `title` or
 * `name` (before the ids become handles). Called after the result is read, never inside a prompt.
 */
function collectLabels(value: unknown, table: HandleTable, labels: Map<string, string>): void {
	if (Array.isArray(value)) {
		for (const v of value) collectLabels(v, table, labels);
		return;
	}
	if (!value || typeof value !== 'object') return;
	const record = value as Record<string, unknown>;
	const name = typeof record.title === 'string' ? record.title : record.name;
	if (typeof record.id === 'string' && typeof name === 'string' && typedIdKind(record.id)) {
		const handle =
			table.handleOf(record.id) ?? table.add(typedIdKind(record.id) as string, record.id);
		labels.set(handle, name.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL));
	}
	for (const v of Object.values(record)) collectLabels(v, table, labels);
}

/** A failed tool call, for the log: which tool, why, and the names (never values) of its input. */
export interface ToolFailureInfo {
	actionId: string;
	/** A `FamosError` code, or a reason of the host (`unknown_reference`, `second_target`, `error`). */
	code: string;
	inputKeys: string[];
}

export interface AgentToolOutcome {
	/** The result as the model reads it (already wrapped by `asData`). */
	text: string;
	/** Whether the action ran (a draft counts); false for refusals and errors. */
	ok: boolean;
	/** Set when the call created a draft. */
	draftId?: string;
	/** Set with `draftId` when the suggestion is approved by the household's own setting, not a person. */
	automatic?: boolean;
	/** What the stored suggestion is about, from the runner (see `ActionResult`). */
	subject?: string;
}

/**
 * Runs one tool call: handles back to ids (an id the model was never shown is an invented one),
 * the action through the runner (which enforces permissions, the sandbox and approval), and the
 * result back to handles. A draft tool names the draft's source with `draft`.
 */
export async function runAgentTool(call: {
	actions: ActionInvoker;
	actor: Actor;
	table: HandleTable;
	actionId: string;
	kind: 'read' | 'draft';
	input: unknown;
	/** The metadata of the draft this call proposes (draft tools only). */
	draft?: DraftMeta;
	/** The draft's name as a suggestion in the person's words ("Add a task"), for the answer. */
	draftTitle: string;
	/**
	 * What the records shown so far are called (handle → title), filled from the results, so a
	 * later turn can remind the model what its handles stand for.
	 */
	labels?: Map<string, string>;
	/**
	 * The target (id → the words used for it) of each change already proposed in this turn. A second
	 * change to the same target under other words is refused: the model is mapping two different
	 * things to one record.
	 */
	targets?: Map<string, string>;
	/**
	 * Told about every call that fails, with the names of the input fields it had (never their
	 * values: they come from the model and may hold family content), so failures can be logged.
	 */
	onFailure?: (failure: ToolFailureInfo) => void;
	/**
	 * The action's input schema (`AiActionInfo.inputSchema`), so references in typed-id fields are
	 * resolved forgivingly (`resolveReferences`); without it only exact handles are mapped.
	 */
	schema?: Record<string, unknown>;
	/** The family, so a member field may hold a person's name. */
	people?: readonly { id: string; displayName: string }[];
	/** The family language, for matching names. */
	locale?: string;
}): Promise<AgentToolOutcome> {
	const { actionId, table } = call;
	const repaired = repairInput(call.input ?? {}, table.toId);
	const resolved = call.schema
		? resolveReferences(repaired, call.schema, {
				table,
				...(call.people && { people: call.people }),
				...(call.locale && { locale: call.locale }),
			})
		: { input: repaired, unknown: [] };
	const input = resolved.input;
	const inputKeys =
		call.input && typeof call.input === 'object' && !Array.isArray(call.input)
			? Object.keys(call.input)
			: [];
	const fail = (code: string, message: string): AgentToolOutcome => {
		call.onFailure?.({ actionId, code, inputKeys });
		return { ok: false, text: asData(actionId, message) };
	};
	const unknown = [...new Set([...resolved.unknown, ...unknownIdFields(input, table)])];
	if (unknown.length > 0)
		return fail(
			'unknown_reference',
			refusalText(
				'unknown',
				`No such reference in ${unknown
					.slice(0, 4)
					.map((field) => `'${field}'`)
					.join(
						', ',
					)}: it is not one an earlier result gave. Leave the field out when it is optional, pass the name where the tool takes one, or look the thing up with a read tool and use the reference it returns.`,
			),
		);
	const target = call.kind === 'draft' ? targetOf(input) : null;
	const earlier = target ? call.targets?.get(target.id) : undefined;
	if (target && earlier !== undefined && earlier.toLocaleLowerCase() !== target.words)
		return fail(
			'second_target',
			refusalText(
				'unknown',
				`A change to this one was already suggested in this turn for '${earlier}', which is not '${target.said}'. If '${target.said}' is not on the list, tell the person.`,
			),
		);
	try {
		const result: ActionResult<unknown> = await call.actions.invoke(
			actionId,
			input,
			call.actor,
			call.kind === 'draft' && call.draft ? { draft: call.draft } : undefined,
		);
		if (result.status === 'drafted') {
			if (target) call.targets?.set(target.id, target.said);
			const what = result.subject ? `${call.draftTitle}: ${result.subject}` : call.draftTitle;
			const when = (at: { date: string; time?: string }) =>
				at.time ? `${at.date} ${at.time}` : at.date;
			const there = result.instead;
			// What is there is named, so the person hears which one; only they choose to change it,
			// on the suggestion, when they decide. The agent never does.
			const exists = there
				? ` Already there: ${there.name}${there.at ? `, ${when(there.at)}` : ''}. You can ${
						there.to ? `move that one to ${when(there.to)}` : 'change that one'
					} instead when you decide.`
				: result.mayExist
					? result.mayExist === 'some'
						? ' Some of it may already be there.'
						: ` It may already be there${result.subject ? ` (${result.subject})` : ''}.`
					: '';
			const approval = result.autoApproval
				? `Suggested: ${what}. It will be added automatically in a moment.`
				: result.decidedByOthers
					? `Suggested, not added yet: ${what}. It appears once someone else in the household approves it.`
					: `Suggested, not added yet: ${what}. It appears once someone in the household approves it.`;
			// For the model only: what the words for the person leave unsaid.
			const note = [
				result.decidedByOthers ? 'The person asking cannot approve it themselves.' : '',
				exists ? 'Say what is already there, too.' : '',
			]
				.filter(Boolean)
				.join(' ');
			return {
				ok: true,
				draftId: result.draftId,
				...(result.autoApproval && { automatic: true }),
				...(result.subject && { subject: result.subject }),
				text: asData(
					actionId,
					JSON.stringify({
						status: 'drafted',
						suggestion: table.add('draft', result.draftId),
						...(result.mayExist && { mayExist: result.mayExist }),
						// Ready words for the person, written to them: models that paraphrase a note still
						// say "added" otherwise. Everything in it may be said as it is.
						say: `${approval}${exists}`,
						...(note && { note }),
					}),
				),
			};
		}
		if (call.labels) collectLabels(result.output, table, call.labels);
		return {
			ok: true,
			text: asData(actionId, fitResult(readableOutput(result.output, table))),
		};
	} catch (error) {
		call.onFailure?.({
			actionId,
			code: isFamosError(error) ? error.code : 'error',
			inputKeys,
		});
		return { ok: false, text: asData(actionId, toolFailure(error)) };
	}
}
