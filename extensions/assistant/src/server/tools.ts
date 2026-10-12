import {
	type ActionInvoker,
	type Actor,
	type AiActionInfo,
	asData,
	type HandleTable,
	type LlmChatTool,
	MAX_RESULT_BYTES,
	runAgentTool,
} from '@famos/sdk';

// The wrapping of results is shared with MCP; the assistant's tests import it from here.
export { asData, MAX_RESULT_BYTES };

/** The most tools offered in one turn: small models cope badly with many. */
export const MAX_TOOLS = 24;
/** The most tool calls in one turn, whatever the step limit. */
export const MAX_TOOL_CALLS = 12;

/**
 * The words that point at an area come from each extension's catalog and the language packs
 * (`<area>:ai_words`): code holds no words of any language. When there are more tools
 * than fit, the tools of the areas the question seems to be about come first.
 */
const areaWordsKey = (area: string) => `${area}:ai_words`;

/** Personal tools of core and the words that call for them. */
const PERSONAL_TOOLS: Record<string, string> = {
	'core.addMemory': 'assistant:memory_words',
};

/** The words a key lists in every installed language (`ExtensionContext.vocabulary`). */
export type Words = (key: string) => readonly string[];

/** Whether the question uses one of the words (at the start of a word, any case). */
function mentions(question: string, words: readonly string[]): boolean {
	const text = question.toLocaleLowerCase();
	return words.some((word) => {
		let at = text.indexOf(word);
		while (at !== -1) {
			if (at === 0 || !/\p{L}/u.test(text[at - 1] ?? '')) return true;
			at = text.indexOf(word, at + 1);
		}
		return false;
	});
}

export interface AssistantTool {
	/** The action behind it. */
	actionId: string;
	kind: 'read' | 'draft';
	info: AiActionInfo;
}

/** The area (extension id) of an action id. */
export const areaOf = (actionId: string) => actionId.split('.')[0] as string;

/** `calendar.findEvents` → `calendar_findEvents`: providers reject dots in tool names. */
export const toolName = (actionId: string) => actionId.replace('.', '_');

/** Whether a tool changes an existing thing (its input names one by `id`). */
const actsOnExisting = (t: AssistantTool) => {
	const schema = t.info.inputSchema as { properties?: Record<string, unknown> } | undefined;
	return Boolean(schema?.properties && 'id' in schema.properties);
};

/** Keeps at most `MAX_TOOLS`, the ones for the areas the question mentions first. */
export function narrow(
	tools: readonly AssistantTool[],
	question: string,
	words: Words,
): AssistantTool[] {
	if (tools.length <= MAX_TOOLS) return [...tools];
	const areas = new Set(tools.map((t) => areaOf(t.actionId)));
	const mentioned = new Set(
		[...areas].filter((area) => mentions(question, words(areaWordsKey(area)))),
	);
	// Search works across areas, so it is never the one to drop. The personal tools (remember,
	// ask someone) are dropped first unless the question points at them: they must not crowd out
	// the tools of the areas the question is about.
	// Tools that change something already there (they take its `id`) need that thing found
	// first, so outside the areas the question names they come after reading and adding.
	const rank = (t: AssistantTool) => {
		const personal = PERSONAL_TOOLS[t.actionId];
		if (personal) return mentions(question, words(personal)) ? 0 : 3;
		if (mentioned.has(areaOf(t.actionId)) || areaOf(t.actionId) === 'core') return 0;
		return actsOnExisting(t) ? 2 : 1;
	};
	return tools.toSorted((a, b) => rank(a) - rank(b)).slice(0, MAX_TOOLS);
}

/** A call the turn made, for the stored answer (names and outcome, never inputs or results). */
export interface RecordedCall {
	name: string;
	ok: boolean;
	draftId?: string;
}

export interface ToolEnv {
	actions: ActionInvoker;
	actor: Actor;
	table: HandleTable;
	turnId: string;
	calls: RecordedCall[];
	/**
	 * Fields the host sets on a tool's input, per action id. They are hidden from the model's
	 * schema and win over anything it sends: bookkeeping it must not be able to forge, such as
	 * where a question's answer will show.
	 */
	inject?: Record<string, Record<string, unknown>>;
}

/** The JSON Schema without the fields the host sets itself. */
function withoutFields(schema: Record<string, unknown>, fields: readonly string[]) {
	const properties = { ...(schema.properties as Record<string, unknown> | undefined) };
	for (const field of fields) delete properties[field];
	const required = Array.isArray(schema.required)
		? schema.required.filter((r) => !fields.includes(r as string))
		: undefined;
	return { ...schema, properties, ...(required && { required }) };
}

/** Whether the turn used up its tool calls, so the model must answer without tools. */
export const toolsClosed = (calls: readonly RecordedCall[]) => calls.length >= MAX_TOOL_CALLS;

/** Turns the offered actions into the chat's tools. */
export function chatTools(tools: readonly AssistantTool[], env: ToolEnv): LlmChatTool[] {
	let count = 0;
	return tools.map(({ actionId, kind, info }) => ({
		name: toolName(actionId),
		description: [info.description, info.guidance].filter(Boolean).join(' '),
		inputSchema: env.inject?.[actionId]
			? withoutFields(info.inputSchema, Object.keys(env.inject[actionId] ?? {}))
			: info.inputSchema,
		async execute(raw) {
			const index = count++;
			// Calls past the cap run nothing and are not recorded: a model that sends dozens
			// in one step must not fill the stored answer with them.
			const record: RecordedCall = { name: actionId, ok: false };
			if (index < MAX_TOOL_CALLS) env.calls.push(record);
			if (index >= MAX_TOOL_CALLS)
				return asData(
					actionId,
					'Error: the tool limit for this turn was reached. Make no more tool calls; answer from what you have and say what is still to do.',
				);
			const outcome = await runAgentTool({
				actions: env.actions,
				actor: env.actor,
				table: env.table,
				actionId,
				kind,
				input: env.inject?.[actionId]
					? { ...(raw as Record<string, unknown> | null), ...env.inject[actionId] }
					: raw,
				draft: {
					sourceKind: 'assistant',
					sourceId: env.turnId,
					promptVersion: 'assistant.chat/1',
					dedupeKey: `assistant:${env.turnId}:${index}`,
				},
				draftSummary: info.description.split('.')[0] ?? '',
			});
			record.ok = outcome.ok;
			if (outcome.draftId) record.draftId = outcome.draftId;
			return outcome.text;
		},
	}));
}
