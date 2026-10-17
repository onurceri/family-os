import type { OutputMode } from '@famos/sdk';
import type { ProviderKind } from './schemas.ts';

/**
 * The output mode for a provider kind and model id, first match wins (by model id prefix). Kept
 * in line with what the extraction evaluation measures: constrained decoding helps some models
 * and derails others (Gemini repeats itself inside an array under a JSON Schema, and rejects
 * schemas with item limits), so a model is only given the schema once it has shown to follow it.
 * Any other model gets `json`, which every OpenAI-compatible server we know of accepts.
 */
export const OUTPUT_DEFAULTS: readonly {
	kind?: ProviderKind;
	model: string;
	mode: OutputMode;
}[] = [
	{ kind: 'openrouter', model: 'openai/gpt-4.1', mode: 'schema' },
	{ kind: 'openai-compatible', model: 'gpt-4.1', mode: 'schema' },
	{ model: 'google/gemini', mode: 'json' },
	{ model: 'gemini', mode: 'json' },
];

export function outputModeFor(kind: ProviderKind, model: string): OutputMode {
	const id = model.trim().toLowerCase();
	return (
		OUTPUT_DEFAULTS.find((d) => (d.kind === undefined || d.kind === kind) && id.startsWith(d.model))
			?.mode ?? 'json'
	);
}

/** The mode to ask in next when one fails; `text` asks for nothing, so nothing is below it. */
export const NEXT_MODE: Readonly<Record<OutputMode, OutputMode | null>> = {
	schema: 'json',
	json: 'text',
	text: null,
};

/**
 * The JSON value a model's answer holds, or null when there is none. Takes the whole answer when
 * it is JSON, else the inside of a code fence, else the first balanced `{…}` (thinking models
 * may write their reasoning in front). An object that is opened and never closed means the answer
 * was cut off: nothing after it is taken, so a fragment of a larger answer is never mistaken for
 * the whole of it.
 */
export function extractJson(text: string): { value: unknown } | null {
	const answer = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
	const fenced = /```[a-zA-Z]*\s*\n?([\s\S]*?)```/.exec(answer)?.[1]?.trim();
	for (const candidate of [answer, fenced]) {
		if (!candidate) continue;
		try {
			return { value: JSON.parse(candidate) };
		} catch {
			// Not JSON as a whole; look for an object inside.
		}
	}
	let from = answer.indexOf('{');
	while (from !== -1) {
		const end = closingBrace(answer, from);
		if (end === -1) return null;
		try {
			return { value: JSON.parse(answer.slice(from, end + 1)) };
		} catch {
			from = answer.indexOf('{', end + 1);
		}
	}
	return null;
}

/** The index of the brace that closes the one at `from`, or -1; braces inside strings do not count. */
function closingBrace(text: string, from: number): number {
	let depth = 0;
	let inString = false;
	for (let i = from; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (c === '\\') i++;
			else if (c === '"') inString = false;
		} else if (c === '"') inString = true;
		else if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** The instruction appended to the system prompt when the provider is not given the schema. */
export function schemaInstruction(schema: unknown): string {
	return `Answer with one JSON object and nothing else (no code fences, no text around it). It follows this JSON Schema:\n${JSON.stringify(schema)}`;
}
