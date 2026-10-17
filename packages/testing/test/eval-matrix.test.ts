import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmError } from '@famos/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	type Baseline,
	type Cell,
	cellOf,
	compareToBaseline,
	formatCell,
	formatTable,
	observe,
	runEval,
	runPool,
	sumCalls,
	totalsOf,
} from '../src/eval-matrix.ts';
import { createFakeLlm, type EnvCall, type EnvLlm, parseEvalModels, slugOf } from '../src/index.ts';

const call = (fields: Partial<EnvCall> = {}): EnvCall => ({
	feature: 'test.read',
	inputTokens: 100,
	outputTokens: 20,
	reasoningTokens: null,
	cost: 0.001,
	latencyMs: 500,
	finishReason: 'stop',
	errorCode: null,
	outputMode: null,
	...fields,
});

/** An eval model on the fake model, whose every call the "adapter" measured as `measured`. */
function fakeEnv(slug: string, measured: EnvCall = call()) {
	const fake = createFakeLlm();
	const seen: string[] = [];
	const env: EnvLlm = {
		llm: fake,
		label: `fake / ${slug}`,
		slug,
		usage: () => Promise.reject(new Error('not used')),
		async calls(jobId) {
			seen.push(jobId);
			return [measured];
		},
	};
	return { env, fake, seen };
}

const request = {
	role: 'fast' as const,
	feature: 'test.read',
	areas: ['test'],
	schema: z.object({ title: z.string() }),
	prompt: 'Read this',
	timeoutMs: 1000,
};

describe('the models of an eval', () => {
	it('reads providers, models with colons and other addresses', () => {
		expect(
			parseEvalModels(
				'openrouter:google/gemini-2.5-flash, ollama:qwen3:8b@http://pi.local:11434/v1,openai/gpt-4.1-mini,',
				'openrouter',
			),
		).toEqual([
			{ kind: 'openrouter', model: 'google/gemini-2.5-flash' },
			{ kind: 'ollama', model: 'qwen3:8b', baseUrl: 'http://pi.local:11434/v1' },
			{ kind: 'openrouter', model: 'openai/gpt-4.1-mini' },
		]);
		expect(() => parseEvalModels('ollama:', 'openrouter')).toThrow(/no model/);
	});

	it('names models and cases for files', () => {
		expect(slugOf('openrouter-google/gemini-2.5-flash')).toBe('openrouter-google-gemini-2-5-flash');
		expect(slugOf('Two dates: "Oct 3" (school)')).toBe('two-dates-oct-3-school');
	});
});

describe('measuring a case', () => {
	it('keeps each answer with what the adapter measured for its call', async () => {
		const { env, fake, seen } = fakeEnv('a');
		fake.respond({ title: 'Milk' }, new LlmError('invalid_output', 'not the structure'));
		const observed = observe(env);
		await observed.llm.generateObject(request);
		await expect(observed.llm.generateObject(request)).rejects.toThrow();
		expect(new Set(seen).size).toBe(2);
		expect(fake.calls.map((c) => c.jobId)).toEqual(seen);
		expect(observed.calls.map((c) => c.answer)).toEqual([
			{ kind: 'object', feature: 'test.read', output: { title: 'Milk' } },
			{ kind: 'object', feature: 'test.read', error: 'invalid_output' },
		]);
		expect(observed.calls[0]).toMatchObject({ inputTokens: 100, finishReason: 'stop' });
		expect(observed.notes).toEqual(['call failed: invalid_output: not the structure']);
	});

	it('keeps the tool calls of a chat', async () => {
		const { env, fake } = fakeEnv('a');
		fake.respondChat([{ tool: 'find', input: { q: 'milk' } }, { text: 'Found it' }]);
		const observed = observe(env);
		await observed.llm.chat({
			role: 'smart',
			feature: 'test.chat',
			areas: ['test'],
			messages: [{ role: 'user', content: 'Milk?' }],
			tools: [{ name: 'find', description: 'Finds', inputSchema: {}, execute: async () => 'one' }],
			maxSteps: 3,
			timeoutMs: 1000,
		});
		expect(observed.calls.map((c) => c.answer)).toEqual([
			{
				kind: 'chat',
				feature: 'test.chat',
				text: 'Found it',
				toolCalls: [{ name: 'find', input: { q: 'milk' } }],
			},
		]);
	});

	it('adds up a call and its retry, keeping how the last one stopped', () => {
		expect(
			sumCalls([
				call({ finishReason: null, errorCode: 'rejected', cost: null }),
				call({ inputTokens: 50 }),
			]),
		).toEqual({
			inputTokens: 150,
			outputTokens: 40,
			reasoningTokens: null,
			cost: 0.001,
			latencyMs: 1000,
			finishReason: 'stop',
			errorCode: null,
			outputMode: null,
		});
	});

	it('keeps the output modes a call was tried in, in order', () => {
		expect(
			sumCalls([
				call({ finishReason: 'length', errorCode: 'output_too_long', outputMode: 'schema' }),
				call({ outputMode: 'json' }),
				call({ outputMode: 'json' }),
			]).outputMode,
		).toBe('schema>json');
	});
});

describe('the report', () => {
	const verdict = (ok: boolean) => ({
		ok,
		checks: 2,
		failed: ok ? [] : ['the title'],
		lines: [],
	});
	const answer = { kind: 'object' as const, feature: 'f', output: {} };

	it('shows tokens, cost, time and how the model stopped in each cell', () => {
		const passed = cellOf('one', 'a', verdict(true), [{ ...call(), answer }]);
		expect(formatCell(passed)).toBe('✓ 100/20 $0.0010 0.5s stop');
		const failed = cellOf('one', 'a', verdict(false), [
			{
				...call({ inputTokens: 2400, finishReason: 'length', errorCode: 'output_too_long' }),
				answer,
			},
		]);
		expect(formatCell(failed)).toBe('✗ 2.4k/20 $0.0010 0.5s length+output_too_long');
		expect(formatCell(cellOf('one', 'a', null, []))).toBe('- skipped');
		const fellBack = cellOf('one', 'a', verdict(true), [
			{ ...call({ outputMode: 'schema>json' }), answer },
		]);
		expect(formatCell(fellBack)).toBe('✓ 100/20 $0.0010 0.5s stop schema>json');
	});

	it('puts cases in rows and models in columns, with totals under them', () => {
		const cells: Cell[] = [
			cellOf('first case', 'a', verdict(true), [{ ...call(), answer }]),
			cellOf('first case', 'b', verdict(false), [{ ...call(), answer }]),
			cellOf('second case', 'a', verdict(true), [{ ...call(), answer }]),
			cellOf('second case', 'b', null, []),
		];
		const totals = [fakeEnv('a').env, fakeEnv('b').env].map((m) => totalsOf(m, cells));
		expect(totals[1]).toMatchObject({
			cases: 2,
			passed: 0,
			skipped: 1,
			checks: 2,
			failedChecks: 1,
		});
		const table = formatTable(['first case', 'second case'], totals, cells);
		expect(table[0]).toMatch(/^case\s+│ fake \/ a\s+│ fake \/ b$/);
		expect(table[2]).toContain('✓ 100/20');
		expect(table[3]).toContain('- skipped');
		expect(table.find((l) => l.startsWith('passed'))).toMatch(/2\/2\s+│ 0\/2 \(1 skipped\)/);
	});

	it('says which cases fail now that passed in the baseline, and back', () => {
		const cells = [
			cellOf('was fine', 'a', verdict(false), []),
			cellOf('was broken', 'a', verdict(true), []),
			cellOf('new', 'a', verdict(false), []),
		];
		const entry = {
			label: 'a',
			version: null,
			date: '2026-10-17',
			cases: 2,
			passing: ['was fine'],
			failing: { 'was broken': ['x'] },
			cost: 0,
		};
		expect(compareToBaseline(entry, 'a', cells)).toEqual({
			newlyFailing: ['was fine'],
			newlyPassing: ['was broken'],
		});
	});
});

describe('the pool', () => {
	it('runs at most the limit at once, in order', async () => {
		let running = 0;
		let most = 0;
		const results = await runPool([1, 2, 3, 4, 5], 2, async (n) => {
			running++;
			most = Math.max(most, running);
			await new Promise((resolve) => setTimeout(resolve, 5));
			running--;
			return n * 10;
		});
		expect(results).toEqual([10, 20, 30, 40, 50]);
		expect(most).toBe(2);
	});

	it('starts nothing once it may not', async () => {
		let spent = 0;
		const results = await runPool(
			[1, 2, 3],
			1,
			async (n) => {
				spent += n;
				return n;
			},
			() => spent < 3,
		);
		expect(results).toEqual([1, 2, null]);
	});
});

describe('runEval', () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it('runs every case on every model, records the answers and keeps a baseline', async () => {
		dir = mkdtempSync(join(tmpdir(), 'famos-eval-'));
		const a = fakeEnv('a');
		const b = fakeEnv('b');
		a.fake.respond({ title: 'Milk' }, { title: 'Bread' });
		b.fake.respond({ title: 'Milk' }, { title: 'Butter' });
		const lines: string[] = [];
		const cases = [
			{ name: 'milk', want: 'Milk' },
			{ name: 'bread', want: 'Bread' },
		];
		const code = await runEval({
			title: 'Test eval',
			version: 'test/1',
			cases,
			models: [a.env, b.env],
			dir,
			env: {
				FAMOS_EVAL_CONCURRENCY: '1',
				FAMOS_EVAL_RECORD: '1',
				FAMOS_EVAL_BASELINE: '1',
				FAMOS_EVAL_REPORT: join(dir, 'report.json'),
			},
			log: (line) => lines.push(line),
			async run(c, llm) {
				const { output } = await llm.generateObject(request);
				const ok = output.title === c.want;
				return {
					ok,
					checks: 1,
					failed: ok ? [] : ['the title'],
					lines: [`${ok ? '✓' : '✗'} ${c.name}`],
				};
			},
		});
		expect(code).toBe(1);
		const recorded = JSON.parse(readFileSync(join(dir, 'recorded', 'b', 'bread.json'), 'utf8'));
		expect(recorded).toEqual({
			case: 'bread',
			model: 'fake / b',
			version: 'test/1',
			answers: [{ kind: 'object', feature: 'test.read', output: { title: 'Butter' } }],
		});
		const baseline = JSON.parse(readFileSync(join(dir, 'baseline.json'), 'utf8')) as Baseline;
		expect(baseline.models.b).toMatchObject({
			version: 'test/1',
			cases: 2,
			passing: ['milk'],
			failing: { bread: ['the title'] },
			cost: 0.002,
		});
		const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
		expect(report.models.map((m: { passed: number }) => m.passed)).toEqual([2, 1]);
		expect(lines).toContain('✗ bread');
	});

	it('keeps no baseline from a run the provider broke off', async () => {
		dir = mkdtempSync(join(tmpdir(), 'famos-eval-'));
		const a = fakeEnv('a', call({ errorCode: 'unavailable', finishReason: null }));
		a.fake.respond(new LlmError('unavailable', 'The provider is unavailable'));
		const lines: string[] = [];
		await runEval({
			title: 'Test eval',
			cases: [{ name: 'one' }],
			models: [a.env],
			dir,
			env: { FAMOS_EVAL_BASELINE: '1' },
			log: (line) => lines.push(line),
			async run(_c, llm) {
				await llm.generateObject(request).catch(() => null);
				return { ok: false, checks: 1, failed: ['x'], lines: [] };
			},
		});
		expect(
			lines.some((l) => l.startsWith('No baseline kept: the provider failed (unavailable)')),
		).toBe(true);
		expect(existsSync(join(dir, 'baseline.json'))).toBe(false);
	});

	it('stops starting cases at the cost cap and keeps no baseline then', async () => {
		dir = mkdtempSync(join(tmpdir(), 'famos-eval-'));
		const a = fakeEnv('a', call({ cost: 0.5 }));
		a.fake.respond({ title: 'Milk' }, { title: 'Milk' });
		const lines: string[] = [];
		const code = await runEval({
			title: 'Test eval',
			cases: [{ name: 'one' }, { name: 'two' }],
			models: [a.env],
			dir,
			env: { FAMOS_EVAL_CONCURRENCY: '1', FAMOS_EVAL_MAX_COST: '0.4', FAMOS_EVAL_BASELINE: '1' },
			log: (line) => lines.push(line),
			async run(_c, llm) {
				await llm.generateObject(request);
				return { ok: true, checks: 1, failed: [], lines: [] };
			},
		});
		expect(code).toBe(1);
		expect(lines.some((l) => l.includes('1 cases skipped at the cost cap'))).toBe(true);
		expect(lines.some((l) => l.startsWith('The baseline is kept only'))).toBe(true);
	});
});
