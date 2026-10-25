import { utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** How often a process that serves no API says it is alive; the image's health check reads it. */
export const HEARTBEAT_MS = 30_000;
/** Beside the database; `docker/healthcheck.mjs` reads the same name. */
export const HEARTBEAT_FILE = '.worker-heartbeat';

/** Creates the heartbeat file or moves its time to now. */
export function beat(dataDir: string): void {
	const file = join(dataDir, HEARTBEAT_FILE);
	try {
		const now = new Date();
		utimesSync(file, now, now);
	} catch {
		writeFileSync(file, '');
	}
}
