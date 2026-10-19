import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTemplate } from './template.ts';

/**
 * Prepares the family once and announces it to the workers (what it puts in `process.env`
 * reaches every one of them).
 *
 * Everything the run makes in the temp directory (the prepared family, each test's copy, mail
 * drops, the server's own temp files) goes under one root that the teardown removes, also when
 * tests fail or the preparation does.
 */
export async function prepareFamily(leaveOut: readonly string[]) {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'famos-e2e-run-')));
	process.env.FAMOS_E2E_RUN_ROOT = root;
	process.env.TMPDIR = root;
	process.env.TEMP = root;
	process.env.TMP = root;
	try {
		const template = await buildTemplate(leaveOut);
		process.env.FAMOS_E2E_TEMPLATE_ROOT = template.root;
		process.env.FAMOS_E2E_TEMPLATE_DIR = template.dataDir;
		process.env.FAMOS_E2E_TEMPLATE_STATE = template.storageState;
	} catch (error) {
		// Playwright does not run the teardown when the setup throws.
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}

/** Runs once before the workers start. Pets is left out: `extensions.spec.ts` installs it. */
export default async function globalSetup() {
	await prepareFamily(['pets']);
}
