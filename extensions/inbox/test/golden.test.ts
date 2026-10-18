import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LlmError, type LlmErrorCode } from '@famos/sdk';
import { type Baseline, type RecordedAnswer, slugOf } from '@famos/testing';
import { describe, expect, it } from 'vitest';
import { CASES } from '../eval/cases.ts';
import { casesPromptHash, failedChecks, runCaseOn } from '../eval/household.ts';
import { PROMPT_VERSION } from '../src/server/understand/prompt.ts';

/**
 * Real models' answers to the eval's cases, recorded by `FAMOS_EVAL_RECORD=1`, read again through
 * the whole pipeline with the fake model: the parser, the resolvers and the drafting are held to
 * what models really write, at no cost. A case's checks must pass, except those the baseline
 * lists as failing for that model.
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

const recordings = readdirSync(RECORDED, { withFileTypes: true })
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

const replayed = (answer: RecordedAnswer) => {
	if (answer.kind !== 'object') throw new Error('Quick add asks for an object, not a chat');
	if ('error' in answer)
		return new LlmError(answer.error as LlmErrorCode, 'recorded failure', {
			...(answer.text !== undefined && { cause: { text: answer.text } }),
		});
	return answer.output;
};

describe('the prompt fingerprint', () => {
	it('is the one the baseline was measured with', async () => {
		const current = await casesPromptHash();
		for (const [slug, entry] of Object.entries(baseline.models)) {
			expect(
				{ model: slug, version: entry.version, promptHash: entry.promptHash },
				'prompt changed: run the eval matrix and update the baseline and the recordings ' +
					'(FAMOS_EVAL_BASELINE=1 FAMOS_EVAL_RECORD=1 pnpm --filter @famos/ext-inbox eval)',
			).toEqual({ model: slug, version: PROMPT_VERSION, promptHash: current });
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
		// Every case the baseline measured has its recording. A case added since has none until the
		// next full run records it; the replay below skips it, as it has nothing to replay.
		for (const [slug, entry] of Object.entries(baseline.models)) {
			const own = recordings.filter((r) => r.model === slug).map((r) => r.recording.case);
			const measured = [
				...new Set([...entry.passing, ...Object.keys(entry.failing), ...(entry.outages ?? [])]),
			];
			expect(own.sort(), slug).toEqual(measured.sort());
			expect(
				measured.filter((name) => !CASES.some((c) => c.name === name)),
				`${slug}: cases the baseline names but the eval no longer has`,
			).toEqual([]);
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
			let asked: readonly unknown[] = [];
			const outcome = await runCaseOn(c, {
				prepare(k) {
					k.llm.respond(...recording.answers.map(replayed));
					asked = k.llm.calls;
				},
			});
			// Every recorded answer was asked for again, and no more.
			expect(asked).toHaveLength(recording.answers.length);
			const failed = failedChecks(outcome);
			expect(failed.filter((label) => !knownMisses.has(label))).toEqual([]);
			// A miss the baseline's run measured that code now gets right is no error: the next
			// full run moves it to passing (the baseline is never edited by hand).
			const mended = [...knownMisses].filter((label) => !failed.includes(label));
			if (mended.length > 0)
				console.info(`newly passing · ${model} · ${c.name}: ${mended.join('; ')}`);
		},
	);
});

describe('the eval household', () => {
	it('waits for the retry of a reading the provider broke, as the queue would at home', async () => {
		const c = CASES.find((one) => one.name === 'Meals planned for the week (English)');
		if (!c) throw new Error('expected the case');
		// As gemini-2.5-flash once answered in a full run: a stray character between two mentions.
		const broken =
			'{"label":"Meal plan","intent":"actionable","mentions":[{"kind":"kitchen.meal","title":"Tacos","date":{"text":"Wednesday","weekday":3}},跹{"kind":"kitchen.meal","title":"Fish pie","variant":"dinner","date":{"text":"Friday","weekday":5}}]}';
		const answer = {
			label: 'Meal plan',
			intent: 'actionable',
			mentions: [
				{ kind: 'kitchen.meal', title: 'Tacos', date: { text: 'Wednesday', weekday: 3 } },
				{
					kind: 'kitchen.meal',
					title: 'Fish pie',
					variant: 'dinner',
					date: { text: 'Friday', weekday: 5 },
				},
			],
		};
		let asked: readonly unknown[] = [];
		const outcome = await runCaseOn(c, {
			prepare(k) {
				k.llm.respond(
					new LlmError('invalid_output', 'The model did not answer with JSON', {
						cause: { text: broken },
					}),
					answer,
				);
				asked = k.llm.calls;
			},
		});
		expect(asked).toHaveLength(2);
		expect(failedChecks(outcome)).toEqual([]);
	});
});
