import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
	aiMigrations,
	createAiSdkLlm,
	createAiSettings,
	createSecretBox,
} from '@famos/adapters/llm-aisdk';
import { silentLogger, uuidv7Ids } from '@famos/adapters/runtime';
import { openDatabase, runMigrations } from '@famos/db';
import { afterAll, beforeAll } from 'vitest';
import { embeddingContract } from '../src/contracts/index.ts';

// A stand-in OpenAI-compatible embeddings endpoint on a local port: the vector of a text depends
// only on the text, as the contract wants. No provider and no outside network is involved.
const server = http.createServer((req, res) => {
	let raw = '';
	req.on('data', (chunk) => (raw += chunk));
	req.on('end', () => {
		res.setHeader('content-type', 'application/json');
		if (!req.url?.endsWith('/embeddings')) return res.writeHead(404).end('{}');
		const body = JSON.parse(raw) as { model: string; input: string[] };
		const data = body.input.map((text, index) => ({
			object: 'embedding',
			index,
			embedding: [text.length, [...text].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 97, 1],
		}));
		res.end(
			JSON.stringify({
				object: 'list',
				data,
				model: body.model,
				usage: { prompt_tokens: 1, total_tokens: 1 },
			}),
		);
	});
});

let baseUrl = '';
beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(
	() =>
		new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		}),
);

embeddingContract('llm-aisdk', async () => {
	const { db } = openDatabase({ path: ':memory:' });
	await runMigrations(db, [{ scope: 'ai', migrations: aiMigrations }]);
	const clock = { now: () => Date.UTC(2026, 9, 6, 9) };
	const timeZone = async () => 'UTC';
	const settings = createAiSettings({
		db,
		box: createSecretBox('s'.repeat(32), 'ai-provider-keys'),
		clock,
		ids: uuidv7Ids,
		timeZone,
		resolve: async () => [],
	});
	const closed = new Set<string>();
	const llm = createAiSdkLlm({
		db,
		settings,
		clock,
		ids: uuidv7Ids,
		logger: silentLogger,
		timeZone,
		areaAccess: (area) => (closed.has(area) ? 'off' : 'any'),
	});
	const provider = await settings.createProvider({
		name: 'Embedder',
		kind: 'openai-compatible',
		baseUrl,
		apiKey: 'good-key',
	});
	await settings.setRoles({
		...(await settings.roles()),
		embed: { providerId: provider.id, model: 'embed-ok' },
	});
	return {
		llm,
		unset: async () => {
			await settings.setRoles({ ...(await settings.roles()), embed: null });
		},
		closeArea: async (area) => {
			closed.add(area);
		},
	};
});
