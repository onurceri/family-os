import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// One temp directory per test run. Tests make their own directories with
// mkdtemp(tmpdir(), ...); pointing the temp variables here puts all of them under one root that
// is removed when the run ends, so a developer machine does not fill up with thousands of
// leftovers. Every project lists this file as its globalSetup: the first to run creates the
// root and only that one removes it.
const ROOT = 'FAMOS_TEST_TMP_ROOT';

export default function setup() {
	if (process.env[ROOT]) return;
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'famos-test-run-')));
	process.env[ROOT] = root;
	process.env.TMPDIR = root;
	process.env.TEMP = root;
	process.env.TMP = root;
	return () => {
		rmSync(root, { recursive: true, force: true });
		delete process.env[ROOT];
	};
}
