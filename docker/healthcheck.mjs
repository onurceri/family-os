// The image's HEALTHCHECK. With the API role it asks /health on PORT. A worker-only container
// (FAMOS_ROLES=worker) listens on nothing, so it is healthy while its heartbeat file in the data
// directory is fresh: the worker rewrites it every 30 s, which proves the process is alive.
import { statSync } from 'node:fs';
import { join } from 'node:path';

// Kept in step with apps/server/src/heartbeat.ts (a test checks both).
const HEARTBEAT_FILE = '.worker-heartbeat';
const env = process.env;
const MAX_AGE_MS = 120_000;

const roles = (env.FAMOS_ROLES ?? '')
	.split(',')
	.map((role) => role.trim())
	.filter(Boolean);
const serves = roles.length === 0 || roles.includes('api');

if (serves) {
	fetch(`http://127.0.0.1:${env.PORT || 3000}/health`)
		.then((res) => process.exit(res.ok ? 0 : 1))
		.catch(() => process.exit(1));
} else {
	try {
		const file = join(env.FAMOS_DATA_DIR || '/data', HEARTBEAT_FILE);
		process.exit(Date.now() - statSync(file).mtimeMs < MAX_AGE_MS ? 0 : 1);
	} catch {
		process.exit(1);
	}
}
