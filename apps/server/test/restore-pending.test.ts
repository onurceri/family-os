import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finishRestore } from '../src/restore-pending.ts';
import type { Runtime } from '../src/runtime.ts';

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'famos-restore-pending-'));
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, 'restore-pending.json'),
		JSON.stringify({ restoredAt: '2026-01-01T00:00:00.000Z', previousDb: null }),
	);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const runtimeWith = (reconcileRestore: () => Promise<unknown>) =>
	({
		config: { dbPath: join(dir, 'famos.db') },
		kernel: { reconcileRestore },
		logger: silentLogger,
		telegram: {},
	}) as unknown as Runtime;

describe('finishing a restore', () => {
	it('stops the start when carrying over fails, and keeps the marker for the next start', async () => {
		const runtime = runtimeWith(async () => {
			throw new Error('disk full');
		});
		await expect(finishRestore(runtime)).rejects.toThrow(/did not start.*disk full/);
		expect(await readFile(join(dir, 'restore-pending.json'), 'utf8')).toContain('restoredAt');
	});

	it('removes the marker once it succeeded', async () => {
		const runtime = runtimeWith(async () => ({ kept: 0, failed: 0 }));
		await finishRestore(runtime);
		await expect(readFile(join(dir, 'restore-pending.json'), 'utf8')).rejects.toThrow();
	});
});
