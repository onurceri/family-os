import { AiContextSchema } from './actions.ts';
import type { Actor } from './actor.ts';
import type { ActionInvoker, ActionResult, DraftMeta } from './context.ts';
import { FamosError } from './errors.ts';
import { type HandleTable, namesUnknownId, repairInput, withHandles } from './handles.ts';

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
			return `Error: invalid input${error.details ? ` (${issues(error.details)})` : ''}`;
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

export interface AgentToolOutcome {
	/** The result as the model reads it (already wrapped by `asData`). */
	text: string;
	/** Whether the action ran (a draft counts); false for refusals and errors. */
	ok: boolean;
	/** Set when the call created a draft. */
	draftId?: string;
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
	/** What the draft is, for the answer ("a suggestion was created"). */
	draftSummary: string;
}): Promise<AgentToolOutcome> {
	const { actionId, table } = call;
	const input = repairInput(call.input ?? {}, table.toId);
	if (namesUnknownId(input, table))
		return {
			ok: false,
			text: asData(actionId, 'Error: unknown reference; use the handles from earlier results'),
		};
	try {
		const result: ActionResult<unknown> = await call.actions.invoke(
			actionId,
			input,
			call.actor,
			call.kind === 'draft' && call.draft ? { draft: call.draft } : undefined,
		);
		if (result.status === 'drafted') {
			return {
				ok: true,
				draftId: result.draftId,
				text: asData(
					actionId,
					JSON.stringify({
						status: 'drafted',
						suggestion: table.add('draft', result.draftId),
						// A ready sentence: models that paraphrase a note still say "added" otherwise.
						say: `Suggested, not added yet: ${call.draftSummary}. It appears once a person in the household approves it.`,
					}),
				),
			};
		}
		return {
			ok: true,
			text: asData(actionId, fitResult(readableOutput(result.output, table))),
		};
	} catch (error) {
		return { ok: false, text: asData(actionId, toolFailure(error)) };
	}
}
