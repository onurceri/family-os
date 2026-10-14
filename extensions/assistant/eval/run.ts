import { llmFromEnv } from '@famos/testing';
import { CASES } from './cases.ts';
import { report, runCase } from './harness.ts';

/**
 * Runs the assistant cases against a real model and reports which checks pass. Not part of CI:
 * it costs money and depends on the provider. Cases run in parallel (each on its own kernel), so
 * the run takes about as long as the slowest case. Usage:
 *   FAMOS_EVAL_API_KEY=… [FAMOS_EVAL_MODEL=…] [FAMOS_EVAL_CASE=substring] [FAMOS_EVAL_RAW=1]
 *   pnpm --filter @famos/ext-assistant eval
 */
const env = await llmFromEnv();
if (!env) {
	console.error(
		'Set FAMOS_EVAL_API_KEY (and optionally FAMOS_EVAL_MODEL, FAMOS_EVAL_PROVIDER, FAMOS_EVAL_BASE_URL).',
	);
	process.exit(2);
}
const only = process.env.FAMOS_EVAL_CASE?.toLowerCase();
const cases = CASES.filter((c) => !only || c.name.toLowerCase().includes(only));
const turns = cases.reduce((n, c) => n + c.asks.length, 0);
console.log(`Assistant eval · ${env.label} · ${cases.length} cases, ${turns} turns\n`);

const started = Date.now();
const results = await Promise.all(
	cases.map((c) =>
		runCase(c, env.llm, Boolean(process.env.FAMOS_EVAL_RAW)).catch((error: unknown) => ({
			name: c.name,
			ok: false,
			checks: c.checks.length,
			failed: [`the case did not run: ${error instanceof Error ? error.message : String(error)}`],
			outcome: { turns: [], seeded: {}, timeZone: '' },
			notes: [],
		})),
	),
);
for (const result of results)
	for (const line of report(result, Boolean(process.env.FAMOS_EVAL_VERBOSE))) console.log(line);
const passed = results.filter((r) => r.ok).length;
const checks = results.reduce((n, r) => n + r.checks, 0);
const failedChecks = results.reduce((n, r) => n + r.failed.length, 0);
const usage = await env.usage();
console.log(
	`\n${passed}/${cases.length} cases passed · ${checks - failedChecks}/${checks} checks · ${usage.total.calls} calls · $${usage.total.cost.toFixed(4)} · ${((Date.now() - started) / 1000).toFixed(0)}s`,
);
process.exit(passed === cases.length ? 0 : 1);
