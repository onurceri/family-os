import type { Actor, MemberId } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreTables } from '../src/tables.ts';
import { notesExtension } from './fixtures.ts';
import { createTestKernel, type TestKernel } from './harness.ts';

const BASE = 'https://family.example';
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = 'https://claude.example/callback';

let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
let ada: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({
		extensions: [notesExtension],
		publicUrl: BASE,
		translate: (_locale, key, params) =>
			key === 'app:draft_via_app_member' ? `${params?.name} via ${params?.app}` : key,
	});
	admin = await k.member('admin');
	ada = await k.member('member');
	await k.apiTokens.setEnabled(admin.actor, true);
	await k.runner.invoke('core.setMcpOAuth', { oauthEnabled: true }, admin.actor);
});
afterEach(() => k.close());

const tables = () => k.ctx.db.withTables<CoreTables>();

/** The AI an app key or a sign-in is, as the MCP door makes it. */
const through = (sourceId: string, who = ada.member, roleId = 'member'): Actor => ({
	kind: 'ai',
	mode: 'agent',
	source: 'mcp',
	sourceId,
	onBehalfOf: who.id as MemberId,
	roleId,
});

async function suggest(sourceId: string, body: string) {
	const result = await k.runner.invoke('notes.addNote', { body }, through(sourceId), {
		draft: { sourceKind: 'mcp', sourceId },
	});
	if (result.status !== 'drafted') throw new Error('expected a draft');
	return result.draftId;
}

const listed = async () =>
	(await k.route('core.listDrafts').call({ query: { limit: 50 }, actor: ada.actor })) as {
		id: string;
		app: { id: string; name: string; kind: string } | null;
	}[];

async function signIn(name: string) {
	const clientId = `oauth_client_dynamic_${Math.random().toString(36).slice(2)}`;
	await tables()
		.insertInto('core_oauth_clients')
		.values({
			id: clientId,
			kind: 'dynamic',
			client_id: clientId,
			name,
			redirect_uris: JSON.stringify([REDIRECT]),
			secret_hash: null,
			require_pkce: 1,
			owner_member_id: null,
			created_at: k.clock.now(),
			last_consented_at: null,
			metadata_fetched_at: null,
			metadata_etag: null,
			revoked_at: null,
		})
		.execute();
	const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString('base64url');
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	const { requestId } = await k.oauth.createRequest({
		clientId,
		redirectUri: REDIRECT,
		state: 'xyz',
		codeChallenge: Buffer.from(digest).toString('base64url'),
		codeChallengeMethod: 'S256',
		resource: RESOURCE,
		scope: 'familyos.read familyos.suggest',
	});
	const approved = await k.oauth.approve(ada.actor, requestId);
	await k.oauth.exchangeCode({
		client: { clientId },
		code: approved.code,
		redirectUri: REDIRECT,
		codeVerifier: verifier,
		resource: RESOURCE,
	});
	return { grantId: approved.grantId, clientRowId: clientId };
}

describe('a suggestion from an AI app', () => {
	it('names a personal key by the key’s name, as an AI app', async () => {
		const { token } = await k.apiTokens.create(ada.actor, { name: 'Hermes', scope: 'read_write' });
		const draftId = await suggest(token.id, 'Plasters');
		expect((await listed()).find((d) => d.id === draftId)?.app).toEqual({
			id: token.id,
			name: 'Hermes',
			kind: 'ai',
		});
	});

	it('names a sign-in by the app’s current name, even after the app is renamed', async () => {
		const { grantId, clientRowId } = await signIn('Claude');
		const draftId = await suggest(grantId, 'Batteries');
		expect((await listed()).find((d) => d.id === draftId)?.app).toEqual({
			id: grantId,
			name: 'Claude',
			kind: 'ai',
		});
		await tables()
			.updateTable('core_oauth_clients')
			.set({ name: 'Claude Desktop' })
			.where('id', '=', clientRowId)
			.execute();
		expect((await listed()).find((d) => d.id === draftId)?.app?.name).toBe('Claude Desktop');
	});

	it('names nothing when the key is gone, and nothing for other sources', async () => {
		const draftId = await suggest('api_token_gone', 'Soap');
		expect((await listed()).find((d) => d.id === draftId)?.app).toBeNull();
		const result = await k.runner.invoke(
			'notes.addNote',
			{ body: 'From the assistant' },
			{
				kind: 'ai',
				mode: 'conversation',
				source: 'assistant',
				sourceId: 'asst_thread_1',
				onBehalfOf: ada.member.id as MemberId,
				roleId: 'member',
			},
			{ draft: { sourceKind: 'assistant', sourceId: 'asst_thread_1' } },
		);
		if (result.status !== 'drafted') throw new Error('expected a draft');
		expect((await listed()).find((d) => d.id === result.draftId)?.app).toBeNull();
	});

	it('is named in the notice that it waits, with the person it works for', async () => {
		// A supervised member cannot decide it, so the approvers are told.
		const kid = await k.member('supervised');
		await tables()
			.insertInto('core_api_tokens')
			.values({
				id: 'api_token_hermes',
				member_id: kid.member.id,
				name: 'Hermes',
				token_hash: 'hash',
				scope: 'read_write',
				expires_at: null,
				last_used_at: null,
				created_at: k.clock.now(),
				revoked_at: null,
				oauth_client_id: null,
			})
			.execute();
		const result = await k.runner.invoke(
			'notes.addNote',
			{ body: 'Plasters' },
			through('api_token_hermes', kid.member, 'supervised'),
			{ draft: { sourceKind: 'mcp', sourceId: 'api_token_hermes' } },
		);
		expect(result.status).toBe('drafted');
		k.clock.advance(60_000);
		await k.worker.drain();
		const notes = await tables()
			.selectFrom('core_notifications')
			.select(['member_id', 'body_params'])
			.where('kind', '=', 'core.draftWaiting')
			.execute();
		const forAdmin = notes.find((n) => n.member_id === admin.member.id);
		const who = JSON.parse(forAdmin?.body_params ?? '{}').who as string;
		expect(who).toContain('Hermes');
		expect(who).toContain(kid.member.displayName);
	});
});
