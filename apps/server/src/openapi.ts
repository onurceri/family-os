/**
 * Splits the server's OpenAPI document by owner. The host keeps core's and the app's own routes;
 * each extension gets its routes and its actions, so its web code is typed against only what it
 * owns and can be built without the rest of the app.
 */

/** The parts of an OpenAPI document the split reads; everything else is copied as it is. */
export interface OpenApiDocument {
	info: { title: string };
	paths?: object;
}

/** The extension a path belongs to: `/api/v1/<id>/…` or `/api/v1/actions/<id>.<name>`. */
export function ownerOfPath(path: string): string | null {
	const action = /^\/api\/v1\/actions\/([^./]+)\./.exec(path);
	if (action) return action[1] ?? null;
	const route = /^\/api\/v1\/([^/]+)(\/|$)/.exec(path);
	return route?.[1] ?? null;
}

export function splitOpenApi<T extends OpenApiDocument>(
	doc: T,
	extensionIds: readonly string[],
): { host: T; extensions: Map<string, T> } {
	const ids = new Set(extensionIds);
	const hostPaths: Record<string, unknown> = {};
	const byExtension = new Map<string, Record<string, unknown>>(extensionIds.map((id) => [id, {}]));
	for (const [path, item] of Object.entries(doc.paths ?? {})) {
		const owner = ownerOfPath(path);
		const target = owner && ids.has(owner) ? byExtension.get(owner) : hostPaths;
		if (target) target[path] = item;
	}
	const extensions = new Map<string, T>();
	for (const [id, paths] of byExtension)
		extensions.set(id, { ...doc, info: { ...doc.info, title: `${doc.info.title}: ${id}` }, paths });
	return { host: { ...doc, paths: hostPaths }, extensions };
}
