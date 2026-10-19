import { rm } from 'node:fs/promises';

export default async function globalTeardown() {
	const root = process.env.FAMOS_E2E_RUN_ROOT;
	if (root) await rm(root, { recursive: true, force: true });
}
