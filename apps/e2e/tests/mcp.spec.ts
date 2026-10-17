import { expect, setUpAndSignIn, test } from '../support/fixtures.ts';

/** A JSON-RPC call to the MCP endpoint, the way an AI app makes it. */
async function rpc(url: string, secret: string, method: string, params: unknown = {}) {
	const res = await fetch(`${url}/mcp`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			authorization: `Bearer ${secret}`,
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	const text = await res.text();
	const json = text.startsWith('event:') ? (/^data: (.*)$/m.exec(text)?.[1] ?? '') : text;
	return { status: res.status, body: json ? JSON.parse(json) : null };
}

test('a member connects an AI app with an app key and the app uses it; the call shows in AI activity', async ({
	page,
	family,
}) => {
	await setUpAndSignIn(page);

	await page.goto('/connections');
	await expect(page.getByTestId('mcp-off')).toBeVisible();
	// The switch is a visually hidden checkbox; its label is the target people tap.
	await page.getByText('Allow AI apps to connect', { exact: true }).click();
	// Turning it on asks first; the switch waits for the answer.
	await expect(page.getByRole('switch', { name: /^Allow AI apps/ })).not.toBeChecked();
	await page
		.getByRole('dialog', { name: 'Allow AI apps to connect?' })
		.getByRole('button', { name: 'Turn on' })
		.click();
	await expect(page.getByRole('switch', { name: /^Allow AI apps/ })).toBeChecked();
	await expect(page.getByTestId('mcp-off')).toHaveCount(0);

	// Connect an app: AI apps are on, so the sheet opens at "Create a key for the app".
	await page.getByRole('button', { name: 'Connect an app' }).click();
	const sheet = page.getByTestId('connect-app');
	await sheet.getByLabel('Name', { exact: true }).fill('Claude Desktop');
	await sheet.getByRole('button', { name: 'Create app key' }).click();
	const secret = (await sheet.getByTestId('mcp-secret').textContent()) ?? '';
	expect(secret).toMatch(/^famos_/);
	await expect(sheet.getByTestId('mcp-endpoint')).toHaveText(`${family.url}/mcp`);
	// The settings to copy carry the address and the key.
	await expect(sheet.getByTestId('mcp-settings')).toContainText(`Bearer ${secret}`);
	await sheet.getByRole('button', { name: 'I have copied it' }).click();
	await expect(sheet).toHaveCount(0);
	await expect(page.getByText('Claude Desktop', { exact: false }).first()).toBeVisible();

	// Without the key nothing works; with it, the tools list and a read tool answer.
	expect((await rpc(family.url, 'famos_wrong', 'tools/list')).status).toBe(401);
	const list = await rpc(family.url, secret, 'tools/list');
	expect(list.status).toBe(200);
	const names = list.body.result.tools.map((t: { name: string }) => t.name);
	expect(names).toContain('calendar_findEvents');
	// A read-only key has no tools that suggest changes.
	expect(names).not.toContain('calendar_createEvent');
	const found = await rpc(family.url, secret, 'tools/call', {
		name: 'calendar_findEvents',
		arguments: { from: '2026-10-01', to: '2026-10-31' },
	});
	expect(found.body.result.content[0].text).toContain('tool_result');

	await page.goto('/settings/ai/activity');
	const entry = page.getByTestId('ai-activity-entry').first();
	await expect(entry).toContainText('AI app');
	await expect(entry).toContainText('MCP / Claude Desktop');
	await expect(entry.getByText('Calendar', { exact: true })).toBeVisible();

	// Revoking ends it at once.
	await page.goto('/connections');
	await page.getByRole('button', { name: 'Revoke', exact: true }).click();
	await page.getByRole('button', { name: 'Revoke now' }).click();
	await expect.poll(async () => (await rpc(family.url, secret, 'tools/list')).status).toBe(401);
});
