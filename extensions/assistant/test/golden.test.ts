import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LlmError, type LlmErrorCode } from '@famos/sdk';
import { type Baseline, type RecordedAnswer, slugOf, type TestKernel } from '@famos/testing';
import { describe, expect, it } from 'vitest';
import { CASES } from '../eval/cases.ts';
import { casesPromptHash, EVAL_VERSION, runCase } from '../eval/harness.ts';

/**
 * Real models' answers to the assistant's cases, recorded by `FAMOS_EVAL_RECORD=1`, replayed
 * through the whole turn with the fake model: the reading is resolved, the digests read, the
 * card made and the opening words checked by today's code, and a tool loop runs its recorded
 * calls against today's tools, at no cost. A case's checks must pass, except those the baseline
 * lists as failing for that model. Every replayed card is held to the gate: every fact of the
 * days shown, nothing outside them, no ISO date, no wrong weekday, no "nothing" over things.
 */

const EVAL = join(import.meta.dirname, '..', 'eval');
const RECORDED = join(EVAL, 'recorded');
const baseline = JSON.parse(readFileSync(join(EVAL, 'baseline.json'), 'utf8')) as Baseline;

interface Recording {
	case: string;
	model: string;
	version: string | null;
	promptHash?: string;
	answers: RecordedAnswer[];
}

const recordings = (existsSync(RECORDED) ? readdirSync(RECORDED, { withFileTypes: true }) : [])
	.filter((entry) => entry.isDirectory())
	.flatMap((dir) =>
		readdirSync(join(RECORDED, dir.name))
			.filter((file) => file.endsWith('.json'))
			.map((file) => ({
				model: dir.name,
				file,
				recording: JSON.parse(readFileSync(join(RECORDED, dir.name, file), 'utf8')) as Recording,
			})),
	);

const RECORDING_KEYS = new Set(['case', 'model', 'version', 'promptHash', 'answers']);
const casesBySlug = new Map(CASES.map((c) => [slugOf(c.name), c]));

/** Labels of the checks that are the gate: what code shows must be right whatever was read. */
const GATE = [
	'card: nothing outside the days asked about is shown in them',
	'no ISO date in any reply',
	'no wrong weekday in any reply',
	'no "nothing" over a topic with things',
	'no handle or id in any reply',
];

describe('the prompt fingerprint', () => {
	it('is the one the baseline was measured with', async () => {
		const current = await casesPromptHash();
		for (const [slug, entry] of Object.entries(baseline.models)) {
			expect(
				{ model: slug, version: entry.version, promptHash: entry.promptHash },
				'prompt changed: run the eval matrix and update the baseline and the recordings ' +
					'(FAMOS_EVAL_BASELINE=1 FAMOS_EVAL_RECORD=1 pnpm --filter @famos/ext-assistant eval)',
			).toEqual({ model: slug, version: EVAL_VERSION, promptHash: current });
		}
	});
});

describe('the recordings', () => {
	it('are of the eval cases only, one per case for every model of the baseline', () => {
		expect(Object.keys(baseline.models).length).toBeGreaterThan(0);
		for (const { model, file, recording } of recordings) {
			// Nothing but a made-up case and what the model answered to it.
			expect(
				Object.keys(recording).filter((key) => !RECORDING_KEYS.has(key)),
				file,
			).toEqual([]);
			expect(casesBySlug.get(file.replace(/\.json$/u, ''))?.name, file).toBe(recording.case);
			expect(baseline.models[model], model).toBeDefined();
		}
		for (const slug of Object.keys(baseline.models)) {
			const own = recordings.filter((r) => r.model === slug).map((r) => r.recording.case);
			expect(own.sort(), slug).toEqual(CASES.map((c) => c.name).sort());
		}
	});

	it('were made with the prompt of today', async () => {
		const current = await casesPromptHash();
		for (const { file, recording } of recordings) expect(recording.promptHash, file).toBe(current);
	});
});

describe('recorded model answers, replayed', () => {
	// A case the provider broke off in the baseline's run holds no answer of the model to replay.
	const replayable = recordings.filter(
		(r) => !baseline.models[r.model]?.outages?.includes(r.recording.case),
	);
	it.each(replayable.map((r) => [`${r.model} · ${r.recording.case}`, r] as const))(
		'%s',
		async (_name, { model, recording }) => {
			const c = CASES.find((one) => one.name === recording.case);
			if (!c) throw new Error(`no case named ${recording.case}`);
			const knownMisses = new Set(baseline.models[model]?.failing[c.name] ?? []);
			let kernel: TestKernel | undefined;
			const result = await runCase(c, {
				prepare(k) {
					kernel = k;
					for (const answer of recording.answers) {
						if ('error' in answer) {
							const failure = new LlmError(answer.error as LlmErrorCode, 'recorded failure', {
								...('text' in answer &&
									answer.text !== undefined && { cause: { text: answer.text } }),
							});
							if (answer.kind === 'object') k.llm.respond(failure);
							// The tools it called before it failed ran, as they did then.
							else
								k.llm.respondChat([
									...answer.toolCalls.map((call) => ({ tool: call.name, input: call.input })),
									{ error: failure },
								]);
						} else if (answer.kind === 'object') k.llm.respond(answer.output);
						else
							k.llm.respondChat([
								...answer.toolCalls.map((call) => ({ tool: call.name, input: call.input })),
								{ text: answer.text },
							]);
					}
				},
			});
			// Every recorded answer was asked for again, and no more.
			expect((kernel?.llm.calls.length ?? 0) + (kernel?.llm.chatCalls.length ?? 0)).toBe(
				recording.answers.length,
			);
			// What code shows holds whatever the model read: these never fail.
			expect(result.failed.filter((label) => GATE.includes(label))).toEqual([]);
			expect(result.failed.filter((label) => !knownMisses.has(label))).toEqual([]);
			// A miss the baseline's run measured that code now gets right is no error: the next
			// full run moves it to passing (the baseline is never edited by hand).
			const mended = [...knownMisses].filter((label) => !result.failed.includes(label));
			if (mended.length > 0)
				console.info(`newly passing · ${model} · ${c.name}: ${mended.join('; ')}`);
		},
	);
});
