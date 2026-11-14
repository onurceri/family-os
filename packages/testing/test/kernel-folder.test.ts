import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestKernel } from '../src/index.ts';

let dir: string;
let before: string | undefined;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'famos-kernel-folder-'));
	before = process.env.TMPDIR;
	process.env.TMPDIR = dir;
});
afterEach(async () => {
	if (before === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = before;
	await rm(dir, { recursive: true, force: true });
});

it('removes the folder a test kernel made when it is closed', async () => {
	const k = await createTestKernel();
	expect(await readdir(dir)).toHaveLength(1);
	await k.close();
	expect(await readdir(dir)).toEqual([]);
});
