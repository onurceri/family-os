import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// One temp directory per test run. Tests make their own directories with
// mkdtemp(tmpdir(), ...); pointing the temp variables here puts all of them under one root that
// is removed when the run ends, so a developer machine does not fill up with thousands of
// leftovers. Every project lists this file as its globalSetup: the first to run creates the
// root and only that one removes it.
const ROOT = 'FAMOS_TEST_TMP_ROOT';
const PREFIX = 'famos-test-run-';
const STALE_MS = 24 * 60 * 60 * 1000;

/** Roots of runs that were stopped before they could remove theirs. A day old, so a run still going is never touched. */
function removeStaleRoots(dir: string) {
	for (const name of readdirSync(dir)) {
		if (!name.startsWith(PREFIX)) continue;
		const path = join(dir, name);
		try {
			if (Date.now() - statSync(path).mtimeMs > STALE_MS)
				rmSync(path, { recursive: true, force: true });
		} catch {
			// Gone meanwhile, or not ours to remove.
		}
	}
}

export default function setup() {
	// Every worker inherits this, so a test never depends on the zone of the machine running it
	// (a developer laptop, a CI runner); tests that need a zone say so explicitly.
	process.env.TZ = 'UTC';
	if (process.env[ROOT]) return;
	removeStaleRoots(tmpdir());
	const root = realpathSync(mkdtempSync(join(tmpdir(), PREFIX)));
	process.env[ROOT] = root;
	process.env.TMPDIR = root;
	process.env.TEMP = root;
	process.env.TMP = root;
	return () => {
		rmSync(root, { recursive: true, force: true });
		delete process.env[ROOT];
	};
}
