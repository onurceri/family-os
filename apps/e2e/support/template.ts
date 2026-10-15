import { constants, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, chromium, devices } from '@playwright/test';
import { startFakeModel } from './fake-model.ts';
import { startFamilyOS } from './server.ts';
import { FAMILY_TIME_ZONE, setUpThroughTheUi } from './sign-in.ts';

/**
 * The prepared family (global setup builds it once per run): a data directory that is migrated
 * and set up with the admin Deniz, exactly as `setUpAndSignIn` does through the UI, and the
 * browser state of Deniz signed in. Each test copies the directory and starts its own server on
 * the copy; the secret the server keeps in the data directory comes along, so the session cookie
 * stays valid. Cookies on `localhost` are not bound to a port, so the saved state works on every
 * test's server.
 */
export type Template = { dataDir: string; storageState: string };

type Cookies = Parameters<BrowserContext['addCookies']>[0];

/** The prepared family global setup announced, with the signed-in browser's cookies. */
export function templateFromEnv(): (Template & { cookies: Cookies }) | undefined {
	const dataDir = process.env.FAMOS_E2E_TEMPLATE_DIR;
	const storageState = process.env.FAMOS_E2E_TEMPLATE_STATE;
	if (!dataDir || !storageState) return undefined;
	const { cookies } = JSON.parse(readFileSync(storageState, 'utf8')) as { cookies: Cookies };
	return { dataDir, storageState, cookies };
}

export async function buildTemplate(): Promise<Template & { root: string }> {
	const root = await mkdtemp(join(tmpdir(), 'famos-e2e-template-'));
	const dataDir = join(root, 'data');
	const storageState = join(root, 'signed-in.json');
	await mkdir(dataDir);
	const model = await startFakeModel();
	const family = await startFamilyOS({ modelUrl: model.baseUrl, dataDir });
	const browser = await chromium.launch();
	try {
		const context = await browser.newContext({
			...devices['Pixel 7'],
			baseURL: family.url,
			locale: 'en-US',
			timezoneId: FAMILY_TIME_ZONE,
		});
		const page = await context.newPage();
		await page.goto('/');
		await setUpThroughTheUi(page);
		await context.storageState({ path: storageState });
		await context.close();
	} finally {
		await browser.close();
		// Stopped, not closed: the data directory stays, with SQLite's WAL checkpointed.
		await family.stop();
		await model.close();
	}
	// A new family starts with the core set; the tests cover the offered extensions too.
	const installed = await family.cli(['extensions', 'install', '--all-offered']);
	if (installed.code !== 0)
		throw new Error(`Installing the offered extensions failed:\n${installed.output}`);
	// Started once more, so their migrations run here and not in every test.
	await family.start();
	await family.stop();
	return { root, dataDir, storageState };
}

/** A test's own copy of the prepared data directory (a clone where the file system can). */
export async function copyTemplate(template: Template): Promise<string> {
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-e2e-'));
	await cp(template.dataDir, dataDir, { recursive: true, mode: constants.COPYFILE_FICLONE });
	return dataDir;
}
