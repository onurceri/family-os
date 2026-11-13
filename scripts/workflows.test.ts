import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A checkout leaves the job's token in .git/config for every later step, install and build
 * included. No workflow pushes with git's own credentials (those that push name their token
 * in the step that pushes), so every checkout drops it.
 */
const dir = join(import.meta.dirname, '..', '.github/workflows');

/** Every `actions/checkout` step, as the lines of its own step. */
function checkouts(text: string): { line: number; step: string[] }[] {
	const lines = text.split('\n');
	const found: { line: number; step: string[] }[] = [];
	for (let i = 0; i < lines.length; i++) {
		const first = lines[i] ?? '';
		if (!/uses:\s*actions\/checkout@/.test(first)) continue;
		const stepIndent = /^\s*/.exec(first)?.[0].length ?? 0;
		const step = [first];
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j] ?? '';
			const indent = /^\s*/.exec(line)?.[0].length ?? 0;
			if (line.trim() !== '' && indent < stepIndent) break;
			if (/^\s*- /.test(line) && indent <= stepIndent) break;
			step.push(line);
		}
		found.push({ line: i + 1, step });
	}
	return found;
}

describe('workflow checkouts', () => {
	for (const name of readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
		it(`${name} keeps no credentials in the checked-out repository`, () => {
			for (const { line, step } of checkouts(readFileSync(join(dir, name), 'utf8'))) {
				expect(
					step.some((l) => /^\s*persist-credentials:\s*false\b/.test(l)),
					`${name}:${line} needs persist-credentials: false`,
				).toBe(true);
			}
		});
	}
});
