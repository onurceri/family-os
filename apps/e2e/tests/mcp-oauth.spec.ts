import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { api, expect, setUpAndSignIn, test } from '../support/fixtures.ts';
import { createMember, signInWithPin } from '../support/members.ts';

/** A JSON-RPC call to the MCP endpoint with an access token, the way an AI app makes it. */
async function listTools(url: string, token: string) {
	const res = await fetch(`${url}/mcp`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
	});
	const text = await res.text();
	const json = text.startsWith('event:') ? (/^data: (.*)$/m.exec(text)?.[1] ?? '') : text;
	return { status: res.status, names: json ? names(JSON.parse(json)) : [] };
}
const names = (body: { result?: { tools?: { name: string }[] } }) =>
	(body.result?.tools ?? []).map((tool) => tool.name);

/** The app's own address, where the browser comes back to with the answer. */
async function appCallback() {
	const arrived: URL[] = [];
	const server = createServer((req, res) => {
		arrived.push(new URL(req.url ?? '/', 'http://localhost'));
		res.end('ok');
	});
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
	return {
		origin,
		arrived: async () => {
			await expect.poll(() => arrived.length).toBeGreaterThan(0);
			return arrived[0] as URL;
		},
		close: () => new Promise<void>((done) => server.close(() => done())),
	};
}

test('an AI app signs in with a family account; a PIN cannot approve it; Revoke ends it', async ({
	page,
	browser,
	family,
}) => {
	await setUpAndSignIn(page);
	await api(page, 'POST', '/api/v1/actions/core.setMcpEnabled', { enabled: true });
	const app = await appCallback();

	// The admin lets AI apps sign in (this test runs on plain http, which asks for its own opt-in).
	await page.goto('/settings/connected-apps');
	const signIn = page.getByRole('switch', { name: /^Let AI apps sign in/ });
	await expect(signIn).toBeDisabled();
	await page.getByText('Allow on this home network without https', { exact: true }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Allow', exact: true }).click();
	await expect(page.getByTestId('mcp-http-warning')).toBeVisible();
	await expect(signIn).toBeEnabled();
	await page.getByText('Let AI apps sign in with a FamilyOS account', { exact: true }).click();
	await expect(signIn).toBeChecked();

	// Home Assistant is set up first: its client ID and secret are shown once.
	await page.getByRole('button', { name: 'Connect an AI app' }).click();
	const sheet = page.getByTestId('connect-app');
	await sheet.getByRole('button', { name: /Home Assistant \(sign-in\)/ }).click();
	await sheet.getByLabel('Home Assistant address (optional)').fill(app.origin);
	await sheet.getByRole('button', { name: 'Set up', exact: true }).click();
	const clientId = (await sheet.getByTestId('ha-client-id').textContent()) ?? '';
	const clientSecret = (await sheet.getByTestId('ha-client-secret').textContent()) ?? '';
	expect(clientSecret).toMatch(/^famos_cs_/);
	await expect(sheet.getByTestId('ha-address-out')).toHaveText(`${family.url}/mcp`);
	await sheet.getByRole('button', { name: 'I have copied it' }).click();
	await expect(page.getByText('Home Assistant', { exact: true }).first()).toBeVisible();

	// The app sends the person to FamilyOS; the person narrows it to reading and connects.
	const redirect = `${app.origin}/auth/external/callback`;
	const link = (state: string) =>
		`/oauth/authorize?${new URLSearchParams({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: redirect,
			state,
			scope: 'familyos.read familyos.suggest',
			resource: `${family.url}/mcp`,
		})}`;
	await page.goto(link('s-1'));
	await expect(
		page.getByRole('heading', { name: 'Connect Home Assistant to FamilyOS?' }),
	).toBeVisible();
	await expect(page.getByTestId('consent-member')).toContainText('Deniz');
	await expect(page.getByTestId('consent-host')).toHaveText(new URL(redirect).host);
	await page.getByRole('radio', { name: 'Read only' }).click();
	await page.getByRole('button', { name: 'Connect', exact: true }).click();
	const back = await app.arrived();
	expect(back.pathname).toBe('/auth/external/callback');
	expect(back.searchParams.get('state')).toBe('s-1');
	expect(back.searchParams.get('iss')).toBe(family.url);

	// The app trades the code for tokens and uses them at /mcp, with reading only.
	const tokens = await fetch(`${family.url}/oauth/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code: back.searchParams.get('code') ?? '',
			redirect_uri: redirect,
			client_id: clientId,
			client_secret: clientSecret,
			resource: `${family.url}/mcp`,
		}),
	});
	expect(tokens.status).toBe(200);
	const access = ((await tokens.json()) as { access_token: string }).access_token;
	const listed = await listTools(family.url, access);
	expect(listed.status).toBe(200);
	expect(listed.names).toContain('calendar_findEvents');
	expect(listed.names).not.toContain('calendar_createEvent');

	// A PIN session on a family device cannot approve: it is asked for a password instead.
	// The browser is still on the app's page after the redirect; the API calls need FamilyOS's.
	await page.goto('/');
	await createMember(page, { name: 'Elif', role: 'supervised', about: '9 years old', pin: '2468' });
	const { context, page: tablet } = await signInWithPin(browser, family, 'Elif', '2468');
	await tablet.goto(link('s-2'));
	await expect(
		tablet.getByRole('heading', { name: 'Sign in with your password to connect an AI app' }),
	).toBeVisible();
	await expect(tablet.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0);
	await context.close();

	// Revoke in Settings ends the access at once.
	await page.goto('/settings/connected-apps');
	await expect(page.getByText(/Signed in · Read only/)).toContainText('ends if unused for 90 days');
	await page.getByRole('button', { name: 'Revoke', exact: true }).click();
	await page.getByRole('button', { name: 'Revoke now' }).click();
	await expect.poll(async () => (await listTools(family.url, access)).status).toBe(401);
	await app.close();
});
