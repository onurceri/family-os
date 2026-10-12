import {
	type ActionInvoker,
	type Actor,
	type AiActionInfo,
	asData,
	type HandleTable,
	type LlmChatTool,
	MAX_RESULT_BYTES,
	runAgentTool,
	subjectOf,
	type ToolFailureInfo,
} from '@famos/sdk';

// The wrapping of results is shared with MCP; the assistant's tests import it from here.
export { asData, MAX_RESULT_BYTES };

/** The most tool calls in one turn, whatever the step limit. */
export const MAX_TOOL_CALLS = 12;

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

/** A call the turn made, for the stored answer (names and outcome, never inputs or results). */
export interface RecordedCall {
	name: string;
	ok: boolean;
	draftId?: string;
}

/** A suggestion the turn made, for the line the host adds under the answer. */
export interface Proposal {
	/** The action's English title. */
	title: string;
	/** Catalog key of its name as a suggestion, when it has one. */
	titleKey?: string;
	/** What it is about: the real name of the item, the titles of the items. */
	subject?: string;
	/** Approved by the household's own setting rather than by a person. */
	automatic: boolean;
}

export interface ToolEnv {
	actions: ActionInvoker;
	actor: Actor;
	table: HandleTable;
	turnId: string;
	calls: RecordedCall[];
	/** The suggestions this turn made, in order. */
	proposals?: Proposal[];
	/** What the records shown in this turn are called (handle → title). */
	labels?: Map<string, string>;
	/** The words used for each target changed in this turn (see `runAgentTool`). */
	targets?: Map<string, string>;
	/**
	 * Fields the host sets on a tool's input, per action id. They are hidden from the model's
	 * schema and win over anything it sends: bookkeeping it must not be able to forge, such as
	 * where a question's answer will show.
	 */
	inject?: Record<string, Record<string, unknown>>;
	/** A catalog key in the asker's language (the names of suggestions). */
	translate: (key: string) => string;
	/** Told about each failed call (for the log). */
	onFailure?: (failure: ToolFailureInfo) => void;
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
				draftTitle: info.draftTitle ? env.translate(info.draftTitle) : info.title,
				onFailure: env.onFailure,
				labels: env.labels,
				targets: env.targets,
			});
			record.ok = outcome.ok;
			if (outcome.draftId) {
				record.draftId = outcome.draftId;
				const subject = outcome.subject ?? subjectOf(JSON.stringify(raw ?? {}));
				env.proposals?.push({
					title: info.title,
					...(info.draftTitle && { titleKey: info.draftTitle }),
					...(subject && { subject }),
					automatic: outcome.automatic === true,
				});
			}
			return outcome.text;
		},
	}));
}
