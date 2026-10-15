// Writes the current platform to platform.json, after a change to what the host shares with
// extension packages. Refuses while SDK_VERSION has not been raised as far as the change needs.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkPlatform, currentPlatform, type Platform } from '../src/platform.ts';

const file = join(import.meta.dirname, '..', 'platform.json');
const current = await currentPlatform();
let committed: Platform | undefined;
try {
	committed = JSON.parse(await readFile(file, 'utf8')) as Platform;
} catch {
	committed = undefined;
}
const check = committed ? checkPlatform(committed, current) : undefined;
if (check && !check.ok && check.reason === 'bump') {
	console.error(check.message);
	process.exitCode = 1;
} else {
	await writeFile(file, `${JSON.stringify(current, null, '\t')}\n`);
	console.log(`Wrote ${file} (platform ${current.sdk})`);
}
