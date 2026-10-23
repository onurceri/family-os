import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** What a fake Home Assistant answers for one entity. */
export type FakeEntity = {
	state: string;
	attributes?: Record<string, unknown>;
};

/**
 * A tiny Home Assistant: the four reads FamilyOS makes (`/api/`, `/api/config`, `/api/states`
 * and `/api/states/<id>`) behind a bearer token. `entities` can be changed while it runs.
 */
export async function startFakeHomeAssistant(
	token: string,
	initial: Record<string, FakeEntity> = {},
) {
	const entities = new Map(Object.entries(initial));
	const body = (id: string, entity: FakeEntity) => ({
		entity_id: id,
		state: entity.state,
		attributes: entity.attributes ?? {},
		last_changed: new Date().toISOString(),
	});
	const server = http.createServer((req, res) => {
		const send = (status: number, json: unknown) =>
			res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
		if (req.headers.authorization !== `Bearer ${token}`)
			return send(401, { message: 'Unauthorized' });
		const path = (req.url ?? '').split('?')[0];
		if (path === '/api/') return send(200, { message: 'API running.' });
		if (path === '/api/config') return send(200, { version: '2026.10.2', location_name: 'Home' });
		if (path === '/api/states')
			return send(
				200,
				[...entities].map(([id, e]) => body(id, e)),
			);
		const entity = path?.startsWith('/api/states/') ? entities.get(path.slice(12)) : undefined;
		if (entity && path) return send(200, body(path.slice(12), entity));
		return send(404, { message: 'Entity not found.' });
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		entities,
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

export type FakeHomeAssistant = Awaited<ReturnType<typeof startFakeHomeAssistant>>;
