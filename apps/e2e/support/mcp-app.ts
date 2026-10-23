import { expect, type Page } from '@playwright/test';

/**
 * Turns AI apps on (Connections, as an admin would) and makes an app key that may read and
 * suggest changes. The key is shown once; it belongs to the family `page` is signed in to.
 */
export async function createAiAppKey(page: Page, name: string): Promise<string> {
	await page.goto('/connections');
	const allow = page.getByRole('switch', { name: /^Allow AI apps/ });
	if (!(await allow.isChecked())) {
		await page.getByText('Allow AI apps to connect', { exact: true }).click();
		await page
			.getByRole('dialog', { name: 'Allow AI apps to connect?' })
			.getByRole('button', { name: 'Turn on' })
			.click();
		await expect(allow).toBeChecked();
	}
	await page.getByRole('button', { name: 'Connect an AI app' }).click();
	const sheet = page.getByTestId('connect-app');
	await sheet.getByLabel('Name', { exact: true }).fill(name);
	await sheet.getByLabel('What it may do').selectOption({ label: 'Read and suggest changes' });
	await sheet.getByRole('button', { name: 'Create app key' }).click();
	const secret = (await sheet.getByTestId('mcp-secret').textContent()) ?? '';
	expect(secret).toMatch(/^famos_/);
	await sheet.getByRole('button', { name: 'I have copied it' }).click();
	return secret;
}

/** One tool call on the family's MCP endpoint, the way an AI app makes it. */
export async function callTool(
	url: string,
	secret: string,
	name: string,
	args: unknown,
): Promise<string> {
	const res = await fetch(`${url}/mcp`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			authorization: `Bearer ${secret}`,
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name, arguments: args },
		}),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${name} → ${res.status}`);
	return text;
}
