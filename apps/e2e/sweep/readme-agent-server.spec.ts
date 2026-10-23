import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { api, setUpAndSignIn, test } from '../support/fixtures.ts';
import { createAiAppKey } from '../support/mcp-app.ts';
import { seedSampleFamily } from '../support/sample-data.ts';
import { day } from '../support/today.ts';

/**
 * Not a test and not part of `pnpm e2e`: the sample family with AI apps turned on and an app key
 * for Deniz, kept running so a real MCP client in a sandbox can use it (how
 * sweep/readme-agent.json was recorded). Run with
 *
 *   FAMOS_README_AGENT_DIR=<folder outside the repo> pnpm --filter @famos/e2e exec \
 *     playwright test -c readme.config.ts readme-agent-server
 *
 * It writes `opencode.json` (the MCP server and its key; a throwaway family, never commit it) and
 * `port` into the folder, and runs until `done` appears there. The server listens on every
 * interface, so a sandbox reaches it as host.docker.internal:<port>.
 */
const DIR = process.env.FAMOS_README_AGENT_DIR;
if (DIR) process.env.FAMOS_E2E_HOST = '0.0.0.0';

test('the sample family, for an AI app in a sandbox', async ({ page, family, model }) => {
	test.skip(!DIR, 'FAMOS_README_AGENT_DIR is not set');
	test.setTimeout(30 * 60_000);
	test.setTimeout(30 * 60_000);
	const dir = DIR as string;
	page.setDefaultTimeout(15_000);
	await mkdir(dir, { recursive: true });
	await page.setViewportSize({ width: 1440, height: 900 });
	await setUpAndSignIn(page);
	const ids = await seedSampleFamily(page, model);
	// Tomorrow's dinner is planned, so a question about it has an answer.
	await api(page, 'POST', '/api/v1/actions/kitchen.addToMealPlan', {
		date: day(1),
		slot: 'dinner',
		recipeId: ids.recipe,
	});

	const secret = await createAiAppKey(page, 'OpenCode');

	const port = new URL(family.url).port;
	await writeFile(
		join(dir, 'opencode.json'),
		JSON.stringify(
			{
				$schema: 'https://opencode.ai/config.json',
				mcp: {
					familyos: {
						type: 'remote',
						url: `http://host.docker.internal:${port}/mcp`,
						headers: { Authorization: `Bearer ${secret}` },
						enabled: true,
					},
				},
			},
			null,
			2,
		),
	);
	await writeFile(join(dir, 'port'), port);
	for (let i = 0; i < 1800 && !existsSync(join(dir, 'done')); i++) await page.waitForTimeout(1000);
});
