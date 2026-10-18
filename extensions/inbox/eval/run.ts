import type { LlmPort } from '@famos/sdk';
import { type CaseVerdict, runEval } from '@famos/testing';
import { PROMPT_VERSION } from '../src/server/process.ts';
import { CASES } from './cases.ts';
import { casesPromptHash, failedChecks, harmfulChecks, runCaseOn } from './household.ts';

/**
 * Runs the extraction cases against real models and reports which checks pass, one column per
 * model. Not part of CI: it costs money and depends on the provider. Each case runs on its own
 * kernel. Usage (the other variables are described in `runEval` of `@famos/testing`):
 *   FAMOS_EVAL_API_KEY=… FAMOS_EVAL_MODELS=openrouter:google/gemini-2.5-flash,openrouter:openai/gpt-4.1-mini \
 *   [FAMOS_EVAL_CASE=substring] [FAMOS_EVAL_RUNS=3] pnpm --filter @famos/ext-inbox eval
 */
async function runCase(c: (typeof CASES)[number], llm: LlmPort): Promise<CaseVerdict> {
	const lines: string[] = [];
	const outcome = await runCaseOn(c, { llm });
	const { status, errorCode, skipped, drafts, members, results } = outcome;
	const ok = status === 'extracted' && results.every((r) => r.ok);
	lines.push(
		`${ok ? '✓' : '✗'} ${c.name}${status === 'extracted' ? '' : ` [${status}: ${errorCode}]`}${skipped ? ` (${skipped} skipped)` : ''}`,
	);
	for (const r of results.filter((r) => !r.ok))
		lines.push(`    ✗ ${r.failure === 'harmful' ? 'HARMFUL ' : ''}${r.check.label}`);
	if (!ok || process.env.FAMOS_EVAL_VERBOSE) {
		const names = Object.fromEntries(Object.entries(members).map(([n, id]) => [id, n]));
		for (const d of drafts) {
			const shown = JSON.stringify(d.input, (_k, v) =>
				typeof v === 'string' && names[v] ? `@${names[v]}` : v,
			);
			lines.push(
				`      · ${d.actionId} ${shown}${d.uncertainFields.length ? ` check:${d.uncertainFields.join(',')}` : ''}${d.mayExist ? ' may-exist' : ''}`,
			);
		}
	}
	return {
		ok,
		checks: results.length,
		failed: failedChecks(outcome),
		harmful: harmfulChecks(outcome),
		lines,
	};
}

process.exit(
	await runEval({
		title: 'Inbox extraction eval',
		version: PROMPT_VERSION,
		promptHash: await casesPromptHash(),
		cases: CASES,
		run: runCase,
		dir: import.meta.dirname,
	}),
);
