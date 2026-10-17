import {
	type ActionInvoker,
	type Actor,
	type AiActionInfo,
	agentInputSchema,
	asData,
	type HandleTable,
	type LlmChatTool,
	MAX_RESULT_BYTES,
	refusalText,
	runAgentTool,
	subjectOf,
	type ToolFailureInfo,
} from '@famos/sdk';

// The wrapping of results is shared with MCP; the assistant's tests import it from here.
export { asData, MAX_RESULT_BYTES };

/** The most tool calls in one turn, whatever the step limit. */
export const MAX_TOOL_CALLS = 12;
/** A turn that repeats a call it already made this many times gets no more tools. */
export const MAX_REPEATS = 2;
/** A turn whose calls failed this many times in a row gets no more tools. */
export const MAX_FAILURES_IN_A_ROW = 4;

/**
 * How a turn's tool calls went, for the loop guard: a model that sends the same call again, or
 * keeps failing, is going round in circles, and answering from what it has beats a timeout.
 */
export interface LoopState {
	/** Each distinct call (action and input) made in the turn, with what it returned. */
	seen: Map<string, Promise<string>>;
	repeats: number;
	failuresInARow: number;
}

export const newLoopState = (): LoopState => ({ seen: new Map(), repeats: 0, failuresInARow: 0 });

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
	/**
	 * Text fields that must say what the person said, per action id (a note to remember): most of
	 * their words must be in `said`, or the call is refused. A model that fills them with what it
	 * guessed is stopped by code, whatever it was told.
	 */
	grounded?: Record<string, string>;
	/** What the person wrote in this conversation, and the family's names, for `grounded`. */
	said?: string;
	/** A catalog key in the asker's language (the names of suggestions). */
	translate: (key: string) => string;
	/** Told about each failed call (for the log). */
	onFailure?: (failure: ToolFailureInfo) => void;
	/** The family, so a member field may hold a person's name. */
	people?: readonly { id: string; displayName: string }[];
	/** The family language, for matching names. */
	locale?: string;
	/** Repeats and failures of the turn (see `toolsClosed`). */
	loop?: LoopState;
}

/** A call's identity for spotting repeats: the action and its input with keys in order. */
function callKey(actionId: string, input: unknown): string {
	const sorted = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(sorted);
		if (value && typeof value === 'object')
			return Object.fromEntries(
				Object.keys(value)
					.sort()
					.map((k) => [k, sorted((value as Record<string, unknown>)[k])]),
			);
		return value;
	};
	return `${actionId} ${JSON.stringify(sorted(input ?? {}))}`;
}

/** At least this share of a grounded text's words must be the person's own. */
const GROUNDED_SHARE = 0.5;

/**
 * Whether a text says what the person said: most of its words (or their first four letters, so
 * a different ending of the same word counts) appear in what they wrote. Words are split at
 * anything that is not a letter or digit, so this works in any language.
 */
export function saidBy(text: string, said: string, locale: string): boolean {
	const words = (value: string) =>
		value
			.toLocaleLowerCase(locale)
			.split(/[^\p{L}\p{N}]+/u)
			.filter((word) => [...word].length > 1);
	const theirs = words(said);
	const stem = (word: string) => [...word].slice(0, 4).join('');
	const stems = new Set(theirs.filter((w) => [...w].length >= 4).map(stem));
	const exact = new Set(theirs);
	const own = words(text);
	if (own.length === 0) return false;
	const found = own.filter((w) => exact.has(w) || ([...w].length >= 4 && stems.has(stem(w))));
	return found.length / own.length >= GROUNDED_SHARE;
}

const REPEAT_NOTE =
	'\n(This call was already made in this turn; this is its answer again. Do not repeat it: use what you have, or answer the person.)';

/** The JSON Schema without the fields the host sets itself. */
function withoutFields(schema: Record<string, unknown>, fields: readonly string[]) {
	const properties = { ...(schema.properties as Record<string, unknown> | undefined) };
	for (const field of fields) delete properties[field];
	const required = Array.isArray(schema.required)
		? schema.required.filter((r) => !fields.includes(r as string))
		: undefined;
	return { ...schema, properties, ...(required && { required }) };
}

/**
 * Whether the model must answer without tools now: the turn used up its tool calls, repeated
 * itself, or kept failing.
 */
export const toolsClosed = (calls: readonly RecordedCall[], loop?: LoopState) =>
	calls.length >= MAX_TOOL_CALLS ||
	(loop !== undefined &&
		(loop.repeats >= MAX_REPEATS || loop.failuresInARow >= MAX_FAILURES_IN_A_ROW));

/** Turns the offered actions into the chat's tools. */
export function chatTools(tools: readonly AssistantTool[], env: ToolEnv): LlmChatTool[] {
	let count = 0;

	async function run(
		{ actionId, kind, info }: AssistantTool,
		schema: Record<string, unknown>,
		raw: unknown,
	): Promise<string> {
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
		const field = env.grounded?.[actionId];
		const written = field ? (raw as Record<string, unknown> | null)?.[field] : undefined;
		if (typeof written === 'string' && !saidBy(written, env.said ?? '', env.locale ?? 'en')) {
			env.onFailure?.({ actionId, code: 'ungrounded', inputKeys: [field as string] });
			if (env.loop) env.loop.failuresInARow++;
			return asData(
				actionId,
				refusalText(
					'incomplete',
					`'${field}' must say what the person said in this conversation, in their words; it is not what they said. Do not suggest it.`,
				),
			);
		}
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
			schema,
			...(env.people && { people: env.people }),
			...(env.locale && { locale: env.locale }),
		});
		record.ok = outcome.ok;
		if (env.loop) env.loop.failuresInARow = outcome.ok ? 0 : env.loop.failuresInARow + 1;
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
	}

	return tools.map((tool) => {
		const { actionId, info } = tool;
		const schema = env.inject?.[actionId]
			? withoutFields(info.inputSchema, Object.keys(env.inject[actionId] ?? {}))
			: info.inputSchema;
		return {
			name: toolName(actionId),
			description: [info.description, info.guidance].filter(Boolean).join(' '),
			inputSchema: agentInputSchema(schema),
			async execute(raw) {
				// The same call again gets the same answer without running: a read would say the
				// same, and a suggestion made twice would be two suggestions.
				const key = callKey(actionId, raw);
				const before = env.loop?.seen.get(key);
				if (env.loop && before !== undefined) {
					env.loop.repeats++;
					return `${await before}${REPEAT_NOTE}`;
				}
				// Kept before it runs, so the same call twice in one step also runs once.
				const answer = run(tool, schema, raw);
				env.loop?.seen.set(key, answer);
				return answer;
			},
		};
	});
}
