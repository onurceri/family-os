import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterAll, expect, it } from 'vitest';
import { compressDir } from '../scripts/compress-build.mjs';

const dir = mkdtempSync(join(tmpdir(), 'famos-compress-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('writes smaller .br and .gz copies of scripts and styles only', () => {
	mkdirSync(join(dir, '_app'), { recursive: true });
	const js = 'export const answer = 42;\n'.repeat(200);
	writeFileSync(join(dir, '_app', 'a.js'), js);
	writeFileSync(join(dir, 'tiny.js'), 'x');
	writeFileSync(join(dir, 'logo.png'), js);
	expect(compressDir(dir)).toBe(1);
	expect(brotliDecompressSync(readFileSync(join(dir, '_app', 'a.js.br'))).toString()).toBe(js);
	expect(gunzipSync(readFileSync(join(dir, '_app', 'a.js.gz'))).toString()).toBe(js);
	expect(() => readFileSync(join(dir, 'tiny.js.br'))).toThrow();
	expect(() => readFileSync(join(dir, 'logo.png.gz'))).toThrow();
});
