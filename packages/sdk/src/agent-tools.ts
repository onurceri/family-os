import { AiContextSchema } from './actions.ts';
import type { Actor } from './actor.ts';
import type { ActionInvoker, ActionResult, DraftMeta } from './context.ts';
import { FamosError } from './errors.ts';
import {
	type HandleTable,
	repairInput,
	typedIdKind,
	unknownIdFields,
	withHandles,
} from './handles.ts';

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

/** What a failed call tells the model: enough to fix the input or to say it cannot be done. */
export function toolFailure(error: unknown): string {
	if (error instanceof FamosError) {
		if (error.code === 'bad_request')
			// Without details the action itself refused the input and says why (an unknown list
			// name, with the real names).
			return error.details
				? `Error: invalid input (${issues(error.details)})`
				: `Error: ${error.message}`;
		if (error.code === 'forbidden') return 'Error: not allowed for this person';
		if (error.code === 'not_found') return 'Error: not found';
		return `Error: ${error.message}`;
	}
	return 'Error: the tool failed';
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

/** An action's output as the model reads it: ids become handles, and record lists are compact. */
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
	return compact(withHandles(output, table));
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
}): Promise<AgentToolOutcome> {
	const { actionId, table } = call;
	const input = repairInput(call.input ?? {}, table.toId);
	const inputKeys =
		call.input && typeof call.input === 'object' && !Array.isArray(call.input)
			? Object.keys(call.input)
			: [];
	const fail = (code: string, message: string): AgentToolOutcome => {
		call.onFailure?.({ actionId, code, inputKeys });
		return { ok: false, text: asData(actionId, message) };
	};
	const unknown = unknownIdFields(input, table);
	if (unknown.length > 0)
		return fail(
			'unknown_reference',
			`Error: unknown reference in ${unknown
				.slice(0, 4)
				.map((field) => `'${field}'`)
				.join(
					', ',
				)}: it is not a handle from earlier results. Look the thing up again with a read tool and use the handle it returns, or pass its name where the tool takes one.`,
		);
	const target = call.kind === 'draft' ? targetOf(input) : null;
	const earlier = target ? call.targets?.get(target.id) : undefined;
	if (target && earlier !== undefined && earlier.toLocaleLowerCase() !== target.words)
		return fail(
			'second_target',
			`Error: a change to this one was already suggested in this turn for '${earlier}', which is not '${target.said}'. If '${target.said}' is not on the list, tell the person.`,
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
				? ` Already there: ${there.name}${there.at ? `, ${when(there.at)}` : ''}; the person can ${
						there.to ? `move it to ${when(there.to)}` : 'change that one'
					} instead when deciding. Tell the person.`
				: result.mayExist
					? result.mayExist === 'some'
						? ' Some of it may already be there; tell the person.'
						: ` It may already be there${result.subject ? ` (${result.subject})` : ''}; tell the person.`
					: '';
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
						// A ready sentence: models that paraphrase a note still say "added" otherwise.
						say: `${
							result.autoApproval
								? `Suggested: ${what}. It will be added automatically in a moment.`
								: result.decidedByOthers
									? `Suggested, not added yet: ${what}. It appears once another person in the household who may approve it does so; this person cannot approve it themselves.`
									: `Suggested, not added yet: ${what}. It appears once a person in the household approves it.`
						}${exists}`,
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
			code: error instanceof FamosError ? error.code : 'error',
			inputKeys,
		});
		return { ok: false, text: asData(actionId, toolFailure(error)) };
	}
}
