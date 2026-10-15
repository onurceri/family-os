import { buildTemplate } from './template.ts';

/**
 * Prepares the family once and announces it to the workers (what it puts in `process.env`
 * reaches every one of them).
 */
export async function prepareFamily(leaveOut: readonly string[]) {
	const template = await buildTemplate(leaveOut);
	process.env.FAMOS_E2E_TEMPLATE_ROOT = template.root;
	process.env.FAMOS_E2E_TEMPLATE_DIR = template.dataDir;
	process.env.FAMOS_E2E_TEMPLATE_STATE = template.storageState;
}

/** Runs once before the workers start. Pets is left out: `extensions.spec.ts` installs it. */
export default async function globalSetup() {
	await prepareFamily(['pets']);
}
