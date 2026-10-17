import {
	type ActionInvoker,
	type Actor,
	type AiActionInfo,
	agentInputSchema,
	asData,
	type HandleTable,
	type LlmChatTool,
	MAX_RESULT_BYTES,
	referenceFields,
	referenceId,
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
	/**
	 * The person's latest message, who they are and their words for themselves ("me", "my"), so a
	 * change to an existing record takes people only when the message names them (see
	 * `withoutUnnamedPeople`).
	 */
	asked?: {
		text: string;
		memberId: string;
		self: readonly string[];
		/** Words for everyone in the family ("everyone", "the whole family"), from the catalog. */
		everyone?: readonly string[];
	};
	/**
	 * What the person and the assistant said in this conversation (not tool results, which the
	 * person never saw), for the words a change names its thing by: a person who confirms the
	 * assistant's "did you mean the Dentist checkup?" names it with the assistant's words.
	 */
	heard?: string;
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

/**
 * A change to an existing record (its input has an `id`) without the person fields whose people
 * the person's latest message does not name: a model that puts the asker into every person field
 * would otherwise replace who an event or a task is for. A person is named by a whole word of
 * their name, or, for the asker, by a word of their own for themselves ("me", from the catalog);
 * a word for everyone ("the whole family", from the catalog) takes an empty list or every member.
 * A field left out is not changed. Everything else is kept as the model sent it.
 */
export function withoutUnnamedPeople(
	raw: unknown,
	schema: Record<string, unknown>,
	env: Pick<ToolEnv, 'asked' | 'people' | 'table' | 'locale'>,
): unknown {
	const input = raw as Record<string, unknown> | null;
	if (!env.asked || !input || typeof input !== 'object' || typeof input.id !== 'string') return raw;
	const locale = env.locale ?? 'en';
	const words = (value: string) =>
		value
			.toLocaleLowerCase(locale)
			.split(/[^\p{L}\p{N}]+/u)
			.filter((word) => word !== '');
	const spoken = words(env.asked.text);
	const said = new Set(spoken);
	const self = env.asked.self.some((word) => said.has(word.toLocaleLowerCase(locale)));
	// "Everyone" may be several words ("the whole family"): they must come in that order.
	const line = ` ${spoken.join(' ')} `;
	const everyone = (env.asked.everyone ?? []).some((phrase) => {
		const parts = words(phrase);
		return parts.length > 0 && line.includes(` ${parts.join(' ')} `);
	});
	const book = { table: env.table, ...(env.people && { people: env.people }), locale };
	const named = (value: unknown) => {
		if (typeof value !== 'string') return false;
		const id = referenceId('member', value, book);
		if (!id) return false;
		if (id === env.asked?.memberId && self) return true;
		const person = env.people?.find((p) => p.id === id);
		return (
			person !== undefined && words(person.displayName).some((w) => w.length > 1 && said.has(w))
		);
	};
	const out = { ...input };
	for (const field of referenceFields(schema, 'member')) {
		if (!(field in out) || out[field] === null) continue;
		const value = out[field];
		const values = Array.isArray(value) ? value : [value];
		// "For everyone" takes an empty list (the whole family, anyone) or one of every member;
		// never a few of them, which is the asker put in again.
		const ids = new Set(values.map((v) => referenceId('member', String(v), book)));
		const all = (env.people ?? []).every((p) => ids.has(p.id));
		if (everyone && (values.length === 0 || all)) continue;
		// An empty list names nobody either: it would make the record the whole family's.
		if (values.length === 0 || !values.every(named)) delete out[field];
	}
	return out;
}

/**
 * Whether words name something the way the person did: each of their words of three or more
 * letters (a trailing plural `s` aside, as the runner's own check of titles does) is a whole word
 * of what the person wrote.
 */
export function namedBy(label: string, said: string, locale: string): boolean {
	const words = (value: string) =>
		value
			.toLocaleLowerCase(locale)
			.split(/[^\p{L}\p{N}]+/u)
			.filter((word) => [...word].length > 2)
			.map((word) => (word.endsWith('s') ? word.slice(0, -1) : word));
	const theirs = new Set(words(said));
	const own = words(label);
	return own.length > 0 && own.every((word) => theirs.has(word));
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
		// The words for the thing to change come from the conversation (the person's, or the
		// assistant's question they answered), never from a tool result alone: a model that writes
		// the title it found instead ("Dentist checkup" for "Dental cleaning") would pass the
		// runner's check of the words against that title.
		const target = raw as { id?: unknown; label?: unknown } | null;
		if (
			kind === 'draft' &&
			(env.heard ?? env.said) !== undefined &&
			typeof target?.id === 'string' &&
			typeof target.label === 'string' &&
			!namedBy(target.label, env.heard ?? env.said ?? '', env.locale ?? 'en')
		) {
			env.onFailure?.({ actionId, code: 'label_not_said', inputKeys: ['label'] });
			if (env.loop) env.loop.failuresInARow++;
			return asData(
				actionId,
				refusalText(
					'unknown',
					`'label' must be the name the person used for it, in their own words, and '${target.label}' is not what they said. If what they named is not there, tell them; do not change something else.`,
				),
			);
		}
		const given = kind === 'draft' ? withoutUnnamedPeople(raw, schema, env) : raw;
		const outcome = await runAgentTool({
			actions: env.actions,
			actor: env.actor,
			table: env.table,
			actionId,
			kind,
			input: env.inject?.[actionId]
				? { ...(given as Record<string, unknown> | null), ...env.inject[actionId] }
				: given,
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
