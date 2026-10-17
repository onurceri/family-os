import { runEval } from '@famos/testing';
import { CASES } from './cases.ts';
import { report, runCase } from './harness.ts';

/**
 * Runs the assistant cases against real models and reports which checks pass, one column per
 * model. Not part of CI: it costs money and depends on the provider. Each case runs on its own
 * kernel. Usage (the other variables are described in `runEval` of `@famos/testing`):
 *   FAMOS_EVAL_API_KEY=… FAMOS_EVAL_MODELS=openrouter:google/gemini-2.5-flash,openrouter:openai/gpt-4.1-mini \
 *   [FAMOS_EVAL_CASE=substring] [FAMOS_EVAL_RAW=1] pnpm --filter @famos/ext-assistant eval
 */
const raw = Boolean(process.env.FAMOS_EVAL_RAW);
const verbose = Boolean(process.env.FAMOS_EVAL_VERBOSE);
process.exit(
	await runEval({
		title: 'Assistant eval',
		cases: CASES,
		async run(c, llm) {
			const result = await runCase(c, llm, raw);
			return {
				ok: result.ok,
				checks: result.checks,
				failed: result.failed,
				lines: report(result, verbose),
			};
		},
		dir: import.meta.dirname,
	}),
);
